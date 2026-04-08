const videoEl = document.getElementById("camera");
const canvasEl = document.getElementById("handCanvas");
const canvasCtx = canvasEl.getContext("2d");
const hudEl = document.getElementById("hud");
const scoreBoardEl = document.getElementById("scoreBoard");
const replayBtnEl = document.getElementById("replayBtn");
const rotateHintEl = document.getElementById("rotateHint");
const gameStartFxEl = document.getElementById("gameStartFx");
const overlayEl = document.getElementById("overlay");
const startBtnEl = document.getElementById("startBtn");
const messageEl = document.getElementById("message");

let currentStream = null;
let cameraInstance = null;
let handsInstance = null;
const PINCH_THRESHOLD = 0.06;
const HOLD_DURATION_MS = 2000;
const POSITION_TOLERANCE_PX = 18;
const SIZE_TOLERANCE_PX = 18;

let holdStartTime = 0;
let trackedRect = null;
let hasCapturedForCurrentHold = false;
let capturedRect = null;
let capturedSnapshot = null;
let isPuzzleMode = false;
let puzzleOrder = [];
let puzzleTiles = [];
let grabbedTileId = -1;
let grabCandidateId = -1;
let grabCandidateStart = 0;
let grabCandidatePoint = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let hoveredSwapTileId = -1;

const PUZZLE_GRID_SIZE = 3;
const PUZZLE_TILE_COUNT = PUZZLE_GRID_SIZE * PUZZLE_GRID_SIZE;
const TILE_GRAB_HOLD_MS = 1000;
const TILE_GRAB_STABLE_PX = 26;
const TILE_RETURN_MS = 280;
const SCORE_STORAGE_KEY = "hand-puzzle-best-score-ms";
const CENTER_EFFECT_DURATION_MS = 2550;

let gameStartedAtMs = 0;
let currentScoreMs = 0;
let bestScoreMs = 0;
let centerEffectTimeoutId = 0;
let orientationSyncTimer = 0;

function getPreferredCameraConstraints() {
    const isLandscape = window.matchMedia("(orientation: landscape)").matches;

    return {
        width: { ideal: isLandscape ? 1280 : 720 },
        height: { ideal: isLandscape ? 720 : 1280 },
        aspectRatio: { ideal: isLandscape ? 16 / 9 : 9 / 16 },
    };
}

async function syncCameraOrientationToDevice() {
    if (!currentStream) {
        return;
    }

    const [videoTrack] = currentStream.getVideoTracks();
    if (!videoTrack || !videoTrack.applyConstraints) {
        return;
    }

    try {
        await videoTrack.applyConstraints(getPreferredCameraConstraints());
        resizeCanvasToVideo();
    } catch (error) {
        // Some devices do not support dynamic orientation constraints.
    }
}

function scheduleCameraOrientationSync() {
    if (orientationSyncTimer) {
        clearTimeout(orientationSyncTimer);
    }

    orientationSyncTimer = setTimeout(() => {
        orientationSyncTimer = 0;
        syncCameraOrientationToDevice();
    }, 120);
}

function isLikelyMobileDevice() {
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 900;
}

function setRotateHintVisible(isVisible) {
    if (!rotateHintEl) {
        return;
    }

    rotateHintEl.classList.toggle("hidden", !isVisible);
}

function updateRotateHintVisibility() {
    const shouldShow =
        isLikelyMobileDevice() &&
        overlayEl.classList.contains("hidden") &&
        window.matchMedia("(orientation: portrait)").matches;

    setRotateHintVisible(shouldShow);
}

function loadBestScore() {
    const raw = localStorage.getItem(SCORE_STORAGE_KEY);
    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.floor(parsed);
}

function formatSeconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

function updateScoreBoard() {
    if (!scoreBoardEl) {
        return;
    }

    const timeText = `Thời gian: ${formatSeconds(currentScoreMs)}`;
    const bestText = bestScoreMs > 0 ? `Kỷ lục: ${formatSeconds(bestScoreMs)}` : "Kỷ lục: --";
    scoreBoardEl.textContent = `${timeText} | ${bestText}`;
}

function setReplayButtonEnabled(isEnabled) {
    if (!replayBtnEl) {
        return;
    }

    replayBtnEl.disabled = !isEnabled;
}

function startGameTimer() {
    gameStartedAtMs = performance.now();
    currentScoreMs = 0;
    updateScoreBoard();
}

function finalizeGameScore(nowMs) {
    if (!gameStartedAtMs) {
        return false;
    }

    currentScoreMs = Math.max(0, Math.floor(nowMs - gameStartedAtMs));

    localStorage.setItem("hand-puzzle-last-score-ms", String(currentScoreMs));

    let isNewBest = false;

    if (!bestScoreMs || currentScoreMs < bestScoreMs) {
        bestScoreMs = currentScoreMs;
        localStorage.setItem(SCORE_STORAGE_KEY, String(bestScoreMs));
        isNewBest = true;
    }

    gameStartedAtMs = 0;
    updateScoreBoard();

    return isNewBest;
}

function playCenterEffect(imageFileName) {
    if (!gameStartFxEl) {
        return;
    }

    gameStartFxEl.src = imageFileName;
    gameStartFxEl.classList.remove("play");
    // Force reflow so repeated plays still restart the animation timeline.
    void gameStartFxEl.offsetWidth;
    gameStartFxEl.classList.add("play");
}

function clearPendingCenterEffects() {
    if (centerEffectTimeoutId) {
        clearTimeout(centerEffectTimeoutId);
        centerEffectTimeoutId = 0;
    }
}

function playCenterEffectsSequence(imageFileNames) {
    clearPendingCenterEffects();

    if (!imageFileNames.length) {
        return;
    }

    let index = 0;

    const playNext = () => {
        playCenterEffect(imageFileNames[index]);
        index += 1;

        if (index < imageFileNames.length) {
            centerEffectTimeoutId = setTimeout(playNext, CENTER_EFFECT_DURATION_MS + 100);
        } else {
            centerEffectTimeoutId = 0;
        }
    };

    playNext();
}

function resizeCanvasToVideo() {
    const width = videoEl.videoWidth || window.innerWidth;
    const height = videoEl.videoHeight || window.innerHeight;

    if (canvasEl.width !== width || canvasEl.height !== height) {
        canvasEl.width = width;
        canvasEl.height = height;
    }
}

function distance2d(pointA, pointB) {
    return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

function getPinchPoint(landmarks) {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];

    if (!thumbTip || !indexTip) {
        return null;
    }

    const isPinching = distance2d(thumbTip, indexTip) < PINCH_THRESHOLD;

    if (!isPinching) {
        return null;
    }

    return {
        x: (thumbTip.x + indexTip.x) / 2,
        y: (thumbTip.y + indexTip.y) / 2,
    };
}

function createRectFromPinches(firstPinch, secondPinch) {
    const x1 = firstPinch.x * canvasEl.width;
    const y1 = firstPinch.y * canvasEl.height;
    const x2 = secondPinch.x * canvasEl.width;
    const y2 = secondPinch.y * canvasEl.height;

    return {
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
    };
}

function areRectsStable(previousRect, currentRect) {
    const prevCenterX = previousRect.left + previousRect.width / 2;
    const prevCenterY = previousRect.top + previousRect.height / 2;
    const currCenterX = currentRect.left + currentRect.width / 2;
    const currCenterY = currentRect.top + currentRect.height / 2;

    const centerDelta = Math.hypot(prevCenterX - currCenterX, prevCenterY - currCenterY);
    const widthDelta = Math.abs(previousRect.width - currentRect.width);
    const heightDelta = Math.abs(previousRect.height - currentRect.height);

    return (
        centerDelta <= POSITION_TOLERANCE_PX &&
        widthDelta <= SIZE_TOLERANCE_PX &&
        heightDelta <= SIZE_TOLERANCE_PX
    );
}

function resetHoldTracking() {
    holdStartTime = 0;
    trackedRect = null;
    hasCapturedForCurrentHold = false;
}

function resetPuzzleInteraction() {
    grabbedTileId = -1;
    grabCandidateId = -1;
    grabCandidateStart = 0;
    grabCandidatePoint = null;
    dragOffsetX = 0;
    dragOffsetY = 0;
    hoveredSwapTileId = -1;
}

function clearPuzzleStateForNewRound() {
    isPuzzleMode = false;
    puzzleOrder = [];
    puzzleTiles = [];
    capturedRect = null;
    capturedSnapshot = null;
    resetPuzzleInteraction();
    resetHoldTracking();
    setReplayButtonEnabled(false);
    gameStartedAtMs = 0;
    updateRotateHintVisibility();
}

function createShuffledPuzzleOrder() {
    const order = Array.from({ length: PUZZLE_TILE_COUNT }, (_, index) => index);

    // Shuffle until there is at least one moved tile so the puzzle is visibly mixed.
    do {
        for (let i = order.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
    } while (order.every((value, index) => value === index));

    return order;
}

function activatePuzzleMode(sourceImage, rect) {
    if (isPuzzleMode) {
        return;
    }

    captureRectangleFromImage(sourceImage, rect);
    if (!capturedSnapshot || !capturedRect) {
        return;
    }

    puzzleOrder = createShuffledPuzzleOrder();
    initializePuzzleTiles();
    resetPuzzleInteraction();
    startGameTimer();
    setReplayButtonEnabled(true);
    clearPendingCenterEffects();
    playCenterEffect("GameStart.png");
    isPuzzleMode = true;
    hasCapturedForCurrentHold = true;
    resetHoldTracking();
}

function replayCurrentPuzzle() {
    if (!isPuzzleMode) {
        return;
    }

    clearPendingCenterEffects();
    clearPuzzleStateForNewRound();

    currentScoreMs = 0;
    updateScoreBoard();
    hudEl.textContent = "Sẵn sàng chụp vùng mới";
}

function getTileHomeSlotIndex(tile) {
    if (!capturedRect) {
        return -1;
    }

    const tileWidth = capturedRect.width / PUZZLE_GRID_SIZE;
    const tileHeight = capturedRect.height / PUZZLE_GRID_SIZE;

    const col = Math.round((tile.homeX - capturedRect.left) / tileWidth);
    const row = Math.round((tile.homeY - capturedRect.top) / tileHeight);

    if (col < 0 || col >= PUZZLE_GRID_SIZE || row < 0 || row >= PUZZLE_GRID_SIZE) {
        return -1;
    }

    return row * PUZZLE_GRID_SIZE + col;
}

function isPuzzleSolved() {
    if (!isPuzzleMode || !capturedRect || puzzleTiles.length !== PUZZLE_TILE_COUNT) {
        return false;
    }

    if (grabbedTileId >= 0) {
        return false;
    }

    for (const tile of puzzleTiles) {
        if (tile.returning) {
            return false;
        }

        if (tile.sourceIndex !== getTileHomeSlotIndex(tile)) {
            return false;
        }
    }

    return true;
}

function initializePuzzleTiles() {
    if (!capturedRect || !capturedSnapshot || puzzleOrder.length !== PUZZLE_TILE_COUNT) {
        puzzleTiles = [];
        return;
    }

    const tileWidth = capturedRect.width / PUZZLE_GRID_SIZE;
    const tileHeight = capturedRect.height / PUZZLE_GRID_SIZE;

    puzzleTiles = [];

    for (let destinationIndex = 0; destinationIndex < PUZZLE_TILE_COUNT; destinationIndex += 1) {
        const destinationCol = destinationIndex % PUZZLE_GRID_SIZE;
        const destinationRow = Math.floor(destinationIndex / PUZZLE_GRID_SIZE);

        const homeX = capturedRect.left + destinationCol * tileWidth;
        const homeY = capturedRect.top + destinationRow * tileHeight;

        puzzleTiles.push({
            id: destinationIndex,
            sourceIndex: puzzleOrder[destinationIndex],
            homeX,
            homeY,
            x: homeX,
            y: homeY,
            width: tileWidth,
            height: tileHeight,
            returning: false,
            returnStart: 0,
            returnFromX: homeX,
            returnFromY: homeY,
            keepHomeBlack: false,
        });
    }
}

function getAllPinchPoints(multiHandLandmarks) {
    if (!multiHandLandmarks) {
        return [];
    }

    const points = [];
    for (const landmarks of multiHandLandmarks) {
        const pinchPoint = getPinchPoint(landmarks);
        if (pinchPoint) {
            points.push({
                x: pinchPoint.x * canvasEl.width,
                y: pinchPoint.y * canvasEl.height,
            });
        }
    }

    return points;
}

function findTopTileAtPoint(pointX, pointY) {
    for (let i = puzzleTiles.length - 1; i >= 0; i -= 1) {
        const tile = puzzleTiles[i];

        if (tile.id === grabbedTileId) {
            continue;
        }

        if (
            pointX >= tile.x &&
            pointX <= tile.x + tile.width &&
            pointY >= tile.y &&
            pointY <= tile.y + tile.height
        ) {
            return tile;
        }
    }

    return null;
}

function getTileById(tileId) {
    return puzzleTiles.find((tile) => tile.id === tileId) || null;
}

function beginGrabTile(tile, pinchPoint, nowMs) {
    grabbedTileId = tile.id;
    dragOffsetX = pinchPoint.x - tile.x;
    dragOffsetY = pinchPoint.y - tile.y;
    tile.returning = false;
    tile.returnStart = 0;
    tile.x = pinchPoint.x - dragOffsetX;
    tile.y = pinchPoint.y - dragOffsetY;

    // Bring held tile to the top layer.
    const oldIndex = puzzleTiles.findIndex((item) => item.id === tile.id);
    if (oldIndex >= 0) {
        const [grabbed] = puzzleTiles.splice(oldIndex, 1);
        puzzleTiles.push(grabbed);
    }

    grabCandidateId = -1;
    grabCandidateStart = nowMs;
    grabCandidatePoint = null;
    hoveredSwapTileId = -1;
}

function startTileReturn(tile, nowMs, keepHomeBlack) {
    tile.returning = true;
    tile.returnStart = nowMs;
    tile.returnFromX = tile.x;
    tile.returnFromY = tile.y;
    tile.keepHomeBlack = keepHomeBlack;
}

function swapTileHomes(firstTile, secondTile) {
    const homeX = firstTile.homeX;
    const homeY = firstTile.homeY;
    firstTile.homeX = secondTile.homeX;
    firstTile.homeY = secondTile.homeY;
    secondTile.homeX = homeX;
    secondTile.homeY = homeY;
}

function updateReturningTiles(nowMs) {
    for (const tile of puzzleTiles) {
        if (!tile.returning) {
            continue;
        }

        const t = Math.min(1, (nowMs - tile.returnStart) / TILE_RETURN_MS);
        const eased = 1 - (1 - t) * (1 - t);
        tile.x = tile.returnFromX + (tile.homeX - tile.returnFromX) * eased;
        tile.y = tile.returnFromY + (tile.homeY - tile.returnFromY) * eased;

        if (t >= 1) {
            tile.x = tile.homeX;
            tile.y = tile.homeY;
            tile.returning = false;
            tile.returnStart = 0;
            tile.keepHomeBlack = false;
        }
    }
}

function selectPinchForGrabbedTile(pinchPoints, tile) {
    if (!pinchPoints.length) {
        return null;
    }

    const tileCenterX = tile.x + tile.width / 2;
    const tileCenterY = tile.y + tile.height / 2;

    let bestPoint = pinchPoints[0];
    let bestDistance = Math.hypot(bestPoint.x - tileCenterX, bestPoint.y - tileCenterY);

    for (let i = 1; i < pinchPoints.length; i += 1) {
        const point = pinchPoints[i];
        const d = Math.hypot(point.x - tileCenterX, point.y - tileCenterY);
        if (d < bestDistance) {
            bestDistance = d;
            bestPoint = point;
        }
    }

    return bestPoint;
}

function updatePuzzleGrabLogic(multiHandLandmarks, nowMs) {
    const pinchPoints = getAllPinchPoints(multiHandLandmarks);

    updateReturningTiles(nowMs);

    if (grabbedTileId >= 0) {
        const grabbedTile = getTileById(grabbedTileId);

        if (!grabbedTile) {
            resetPuzzleInteraction();
            return;
        }

        const controlPoint = selectPinchForGrabbedTile(pinchPoints, grabbedTile);
        if (!controlPoint) {
            const swapTarget = getTileById(hoveredSwapTileId);
            if (swapTarget && swapTarget.id !== grabbedTile.id) {
                swapTileHomes(grabbedTile, swapTarget);
                startTileReturn(grabbedTile, nowMs, false);
                startTileReturn(swapTarget, nowMs, false);
            } else {
                startTileReturn(grabbedTile, nowMs, true);
            }

            hoveredSwapTileId = -1;
            grabbedTileId = -1;
            return;
        }

        grabbedTile.x = controlPoint.x - dragOffsetX;
        grabbedTile.y = controlPoint.y - dragOffsetY;

        const targetTile = findTopTileAtPoint(controlPoint.x, controlPoint.y);
        hoveredSwapTileId = targetTile ? targetTile.id : -1;
        return;
    }

    hoveredSwapTileId = -1;

    if (!pinchPoints.length) {
        grabCandidateId = -1;
        grabCandidateStart = 0;
        grabCandidatePoint = null;
        return;
    }

    const probePoint = pinchPoints[0];
    const tile = findTopTileAtPoint(probePoint.x, probePoint.y);

    if (!tile) {
        grabCandidateId = -1;
        grabCandidateStart = 0;
        grabCandidatePoint = null;
        return;
    }

    if (grabCandidateId !== tile.id) {
        grabCandidateId = tile.id;
        grabCandidateStart = nowMs;
        grabCandidatePoint = { x: probePoint.x, y: probePoint.y };
        return;
    }

    if (grabCandidatePoint) {
        const shiftDistance = Math.hypot(
            probePoint.x - grabCandidatePoint.x,
            probePoint.y - grabCandidatePoint.y
        );
        if (shiftDistance > TILE_GRAB_STABLE_PX) {
            grabCandidateStart = nowMs;
            grabCandidatePoint = { x: probePoint.x, y: probePoint.y };
            return;
        }
    }

    if (nowMs - grabCandidateStart >= TILE_GRAB_HOLD_MS) {
        beginGrabTile(tile, probePoint, nowMs);
    }
}

function captureRectangleFromImage(sourceImage, rect) {
    const sourceLeft = Math.max(0, Math.floor(rect.left));
    const sourceTop = Math.max(0, Math.floor(rect.top));
    const sourceWidth = Math.min(
        canvasEl.width - sourceLeft,
        Math.max(1, Math.floor(rect.width))
    );
    const sourceHeight = Math.min(
        canvasEl.height - sourceTop,
        Math.max(1, Math.floor(rect.height))
    );

    if (sourceWidth < 2 || sourceHeight < 2) {
        return;
    }

    const snapshotCanvas = document.createElement("canvas");
    snapshotCanvas.width = sourceWidth;
    snapshotCanvas.height = sourceHeight;

    const snapshotCtx = snapshotCanvas.getContext("2d");
    snapshotCtx.drawImage(
        sourceImage,
        sourceLeft,
        sourceTop,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
    );

    capturedSnapshot = snapshotCanvas;
    capturedRect = {
        left: sourceLeft,
        top: sourceTop,
        width: sourceWidth,
        height: sourceHeight,
    };
}

function drawCapturedSnapshot() {
    if (!capturedSnapshot || !capturedRect) {
        return;
    }

    canvasCtx.drawImage(
        capturedSnapshot,
        capturedRect.left,
        capturedRect.top,
        capturedRect.width,
        capturedRect.height
    );
}

function drawPuzzleSnapshot() {
    if (!capturedSnapshot || !capturedRect || puzzleTiles.length !== PUZZLE_TILE_COUNT) {
        return;
    }

    const tileSourceWidth = capturedSnapshot.width / PUZZLE_GRID_SIZE;
    const tileSourceHeight = capturedSnapshot.height / PUZZLE_GRID_SIZE;

    for (const tile of puzzleTiles) {
        if (tile.id === grabbedTileId || tile.keepHomeBlack) {
            canvasCtx.fillStyle = "#000";
            canvasCtx.fillRect(
                tile.homeX,
                tile.homeY,
                tile.width,
                tile.height
            );
        }
    }

    for (const tile of puzzleTiles) {
        if (tile.id === grabbedTileId) {
            continue;
        }

        const sourceCol = tile.sourceIndex % PUZZLE_GRID_SIZE;
        const sourceRow = Math.floor(tile.sourceIndex / PUZZLE_GRID_SIZE);

        canvasCtx.drawImage(
            capturedSnapshot,
            sourceCol * tileSourceWidth,
            sourceRow * tileSourceHeight,
            tileSourceWidth,
            tileSourceHeight,
            tile.x,
            tile.y,
            tile.width,
            tile.height
        );
    }

    if (grabbedTileId >= 0) {
        const grabbedTile = getTileById(grabbedTileId);
        if (grabbedTile) {
            const sourceCol = grabbedTile.sourceIndex % PUZZLE_GRID_SIZE;
            const sourceRow = Math.floor(grabbedTile.sourceIndex / PUZZLE_GRID_SIZE);

            canvasCtx.save();
            canvasCtx.shadowColor = "rgba(0, 0, 0, 0.6)";
            canvasCtx.shadowBlur = 20;
            canvasCtx.shadowOffsetX = 0;
            canvasCtx.shadowOffsetY = 8;
            canvasCtx.globalAlpha = 0.95;

            canvasCtx.drawImage(
                capturedSnapshot,
                sourceCol * tileSourceWidth,
                sourceRow * tileSourceHeight,
                tileSourceWidth,
                tileSourceHeight,
                grabbedTile.x,
                grabbedTile.y,
                grabbedTile.width,
                grabbedTile.height
            );

            canvasCtx.strokeStyle = "#ffffff";
            canvasCtx.lineWidth = 3;
            canvasCtx.strokeRect(
                grabbedTile.x,
                grabbedTile.y,
                grabbedTile.width,
                grabbedTile.height
            );
            canvasCtx.restore();
        }
    }
}

function drawSwapHoverFeedback(nowMs) {
    if (grabbedTileId < 0 || hoveredSwapTileId < 0) {
        return;
    }

    const targetTile = getTileById(hoveredSwapTileId);
    if (!targetTile) {
        return;
    }

    const pulseAlpha = 0.22 + 0.24 * (0.5 + 0.5 * Math.sin(nowMs / 120));
    canvasCtx.save();
    canvasCtx.fillStyle = `rgba(255, 255, 255, ${pulseAlpha.toFixed(3)})`;
    canvasCtx.fillRect(targetTile.x, targetTile.y, targetTile.width, targetTile.height);
    canvasCtx.strokeStyle = "#00e5ff";
    canvasCtx.lineWidth = 3;
    canvasCtx.strokeRect(targetTile.x, targetTile.y, targetTile.width, targetTile.height);
    canvasCtx.restore();
}

function drawGrabCandidateFeedback(nowMs) {
    if (grabbedTileId >= 0 || grabCandidateId < 0) {
        return;
    }

    const tile = getTileById(grabCandidateId);
    if (!tile || !grabCandidateStart) {
        return;
    }

    const grabProgress = Math.max(0, Math.min(1, (nowMs - grabCandidateStart) / TILE_GRAB_HOLD_MS));
    const pulseAlpha = 0.2 + 0.25 * (0.5 + 0.5 * Math.sin(nowMs / 120));

    canvasCtx.save();
    canvasCtx.fillStyle = `rgba(255, 255, 255, ${pulseAlpha.toFixed(3)})`;
    canvasCtx.fillRect(tile.x, tile.y, tile.width, tile.height);

    canvasCtx.strokeStyle = "#00e5ff";
    canvasCtx.lineWidth = 3;
    canvasCtx.strokeRect(tile.x, tile.y, tile.width, tile.height);

    canvasCtx.fillStyle = "#00e5ff";
    canvasCtx.fillRect(tile.x, tile.y + tile.height - 6, tile.width * grabProgress, 6);
    canvasCtx.restore();
}

function drawPuzzleFrame(sourceImage, multiHandLandmarks) {
    const now = performance.now();
    updatePuzzleGrabLogic(multiHandLandmarks, now);

    if (gameStartedAtMs) {
        currentScoreMs = Math.max(0, Math.floor(now - gameStartedAtMs));
        updateScoreBoard();
    }

    if (isPuzzleSolved()) {
        const isNewBest = finalizeGameScore(now);
        if (isNewBest) {
            playCenterEffectsSequence(["Congratulation.png", "NewScore.png"]);
        } else {
            clearPendingCenterEffects();
            playCenterEffect("Congratulation.png");
        }
        clearPuzzleStateForNewRound();

        resizeCanvasToVideo();
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        canvasCtx.drawImage(sourceImage, 0, 0, canvasEl.width, canvasEl.height);
        canvasCtx.restore();
        hudEl.textContent = "Hoàn thành! Sẵn sàng cho lượt chơi mới";
        return;
    }

    resizeCanvasToVideo();
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    canvasCtx.drawImage(sourceImage, 0, 0, canvasEl.width, canvasEl.height);
    drawPuzzleSnapshot();
    drawSwapHoverFeedback(now);
    drawGrabCandidateFeedback(now);
    canvasCtx.restore();

    if (grabbedTileId >= 0) {
        if (hoveredSwapTileId >= 0) {
            hudEl.textContent = "Puzzle 3x3 | Thả tay để đổi chỗ 2 khối";
        } else {
            hudEl.textContent = "Puzzle 3x3 | Đang cầm 1 khối";
        }
    } else if (grabCandidateId >= 0 && grabCandidateStart) {
        const holdPercent = Math.floor(
            Math.min(1, (now - grabCandidateStart) / TILE_GRAB_HOLD_MS) * 100
        );
        hudEl.textContent = `Puzzle 3x3 | Giữ ${(TILE_GRAB_HOLD_MS / 1000).toFixed(1)}s để cầm khối (${holdPercent}%)`;
    } else {
        hudEl.textContent = `Puzzle 3x3 | Chụm ngón tay trên khối ${(TILE_GRAB_HOLD_MS / 1000).toFixed(1)}s để cầm`;
    }
}

function drawRectProgress(rect, progress) {
    const p = Math.max(0, Math.min(1, progress));
    const perimeter = 2 * (rect.width + rect.height);
    let remaining = perimeter * p;

    canvasCtx.beginPath();
    canvasCtx.moveTo(rect.left, rect.top);

    const topSegment = Math.min(rect.width, remaining);
    canvasCtx.lineTo(rect.left + topSegment, rect.top);
    remaining -= topSegment;

    if (remaining > 0) {
        const rightSegment = Math.min(rect.height, remaining);
        canvasCtx.lineTo(rect.left + rect.width, rect.top + rightSegment);
        remaining -= rightSegment;
    }

    if (remaining > 0) {
        const bottomSegment = Math.min(rect.width, remaining);
        canvasCtx.lineTo(rect.left + rect.width - bottomSegment, rect.top + rect.height);
        remaining -= bottomSegment;
    }

    if (remaining > 0) {
        const leftSegment = Math.min(rect.height, remaining);
        canvasCtx.lineTo(rect.left, rect.top + rect.height - leftSegment);
    }

    canvasCtx.stroke();
}

function drawLiveRectangle(rect, holdProgress, nowMs) {
    if (rect.width < 2 || rect.height < 2) {
        return;
    }

    const pulseAlpha = 0.25 + 0.25 * (0.5 + 0.5 * Math.sin(nowMs / 130));
    canvasCtx.fillStyle = `rgba(0, 229, 255, ${pulseAlpha.toFixed(3)})`;
    canvasCtx.strokeStyle = "#00e5ff";
    canvasCtx.lineWidth = 2.5;
    canvasCtx.fillRect(rect.left, rect.top, rect.width, rect.height);
    canvasCtx.strokeRect(rect.left, rect.top, rect.width, rect.height);

    // Pre-capture animation: pulsing alert border + progress along rectangle edge.
    if (holdProgress < 1) {
        canvasCtx.save();
        canvasCtx.lineWidth = 4;
        canvasCtx.strokeStyle = `rgba(255, 244, 79, ${(0.35 + 0.45 * Math.abs(Math.sin(nowMs / 110))).toFixed(3)})`;
        canvasCtx.strokeRect(rect.left, rect.top, rect.width, rect.height);

        canvasCtx.strokeStyle = "#ffffff";
        canvasCtx.lineWidth = 5;
        drawRectProgress(rect, holdProgress);
        canvasCtx.restore();
    }
}

function drawHands(results) {
    if (isPuzzleMode) {
        drawPuzzleFrame(results.image, results.multiHandLandmarks);
        return;
    }

    resizeCanvasToVideo();

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);
    drawCapturedSnapshot();

    const handCount = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
    hudEl.textContent = `Số tay phát hiện: ${handCount}`;

    const pinchPoints = [];

    if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
            const pinchPoint = getPinchPoint(landmarks);
            if (pinchPoint) {
                pinchPoints.push(pinchPoint);
            }
        }

        if (pinchPoints.length === 2) {
            const currentRect = createRectFromPinches(pinchPoints[0], pinchPoints[1]);
            const now = performance.now();
            if (!trackedRect || !areRectsStable(trackedRect, currentRect)) {
                trackedRect = currentRect;
                holdStartTime = now;
                hasCapturedForCurrentHold = false;
            }

            const holdMs = holdStartTime ? now - holdStartTime : 0;
            const holdLeftMs = Math.max(0, HOLD_DURATION_MS - holdMs);
            const holdProgress = Math.min(1, holdMs / HOLD_DURATION_MS);

            drawLiveRectangle(currentRect, holdProgress, now);

            if (!hasCapturedForCurrentHold && holdMs >= HOLD_DURATION_MS) {
                activatePuzzleMode(results.image, currentRect);
                drawPuzzleFrame(results.image, results.multiHandLandmarks);
                canvasCtx.restore();
                return;
            }

            if (hasCapturedForCurrentHold) {
                hudEl.textContent = `Số tay phát hiện: ${handCount} | Đã chụp vùng`;
            } else {
                const progressPercent = Math.floor(holdProgress * 100);
                hudEl.textContent = `Số tay phát hiện: ${handCount} | Sắp chụp ${progressPercent}% (${Math.ceil(holdLeftMs / 1000)}s)`;
            }
        } else {
            resetHoldTracking();
        }
    } else {
        resetHoldTracking();
    }

    canvasCtx.restore();
}

bestScoreMs = loadBestScore();
updateScoreBoard();
setReplayButtonEnabled(false);

if (replayBtnEl) {
    replayBtnEl.addEventListener("click", replayCurrentPuzzle);
}

async function setupMediaPipeHands() {
    const preferred = getPreferredCameraConstraints();

    handsInstance = new Hands({
        locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    handsInstance.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
    });

    handsInstance.onResults(drawHands);

    cameraInstance = new Camera(videoEl, {
        onFrame: async () => {
            await handsInstance.send({ image: videoEl });
        },
        width: preferred.width.ideal,
        height: preferred.height.ideal,
    });
}

async function startCamera() {
    if (typeof Hands === "undefined" || typeof Camera === "undefined") {
        messageEl.textContent = "Không tải được thư viện MediaPipe.";
        return;
    }

    startBtnEl.disabled = true;
    messageEl.textContent = "Đang bật camera và mô hình nhận diện tay...";

    try {
        await setupMediaPipeHands();
        await cameraInstance.start();
        currentStream = videoEl.srcObject;
        await syncCameraOrientationToDevice();
        overlayEl.classList.add("hidden");
        updateRotateHintVisibility();

        // Keep video metadata in sync with canvas resolution.
        videoEl.addEventListener("loadedmetadata", resizeCanvasToVideo, { once: true });
    } catch (error) {
        messageEl.textContent =
            "Không thể mở camera/nhận diện tay. Hãy kiểm tra quyền truy cập hoặc HTTPS.";
        startBtnEl.disabled = false;
        console.error(error);
    }
}

startBtnEl.addEventListener("click", startCamera);

window.addEventListener("resize", updateRotateHintVisibility);
window.addEventListener("orientationchange", updateRotateHintVisibility);
window.addEventListener("resize", scheduleCameraOrientationSync);
window.addEventListener("orientationchange", scheduleCameraOrientationSync);

window.addEventListener("beforeunload", () => {
    clearPendingCenterEffects();

    if (orientationSyncTimer) {
        clearTimeout(orientationSyncTimer);
        orientationSyncTimer = 0;
    }

    if (cameraInstance) {
        cameraInstance.stop();
    }

    if (handsInstance) {
        handsInstance.close();
    }

    if (!currentStream) {
        return;
    }

    for (const track of currentStream.getTracks()) {
        track.stop();
    }
});
