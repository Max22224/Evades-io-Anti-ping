// ==UserScript==
// @name         Evades.io - Balls & Effects Overlay v6.2
// @namespace    https://evades.io/
// @version      6.2
// @description  Visuals for displaying balls and effects in Evades.io
// @match        https://*.evades.io/*
// @match        https://*.evades.online/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    // ==================== НАСТРОЙКИ ГРАФИКИ ====================
    const STROKE_WIDTH = 2;
    const GHOST_ALPHA = 0.13;
    const HARMLESS_ALPHA = 0.13;
    const GRASSHARMLESS_ALPHA = 0.13;
    const DEFAULT_PLAYER_RADIUS = 15;
    const PLAYER_ALPHA = 0.7;

    // ==================== НАСТРОЙКИ ЭКСТРАПОЛЯЦИИ ====================
    const TICK_MS = 1000 / 60;
    let EXTRAPOLATION_TICKS = 2;

    // ==================== КОНФИГУРАЦИЯ ТИПОВ ШАРОВ ====================
    const ALLOWED_PROJECTILES = new Set([18, 33, 79, 83, 108, 145, 147, 186, 215]);

    const DEFAULT_PROJECTILES = new Set([
        1, 4, 7, 14, 15, 21, 32, 35, 37, 38, 40, 46, 52, 54, 56, 59, 62, 70, 72, 75, 82, 85, 86, 96, 99,
        103, 106, 109, 116, 122, 123, 126, 129, 133, 135, 136, 137, 141, 148, 149, 150, 151, 152, 153,
        154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 166, 168, 169, 170, 172, 173, 174, 178,
        179, 185, 190, 191, 194, 198, 213, 222, 224, 226, 234
    ]);

    const EXCLUDED_OTHERS = new Set([30, 43, 44, 71, 197, 200, 227, 228, 229]);

    function canBounce(type) {
        if (ALLOWED_PROJECTILES.has(type)) return true;
        if (DEFAULT_PROJECTILES.has(type)) return false;
        if (EXCLUDED_OTHERS.has(type)) return false;
        return true;
    }

    // ==================== БАЗА ЦВЕТОВ АУР (True Type) ====================
    const TARGET_AURAS = new Set([45, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 61, 62, 63, 64, 65, 66, 67, 70, 71]);

    const AURA_COLORS = {
        0: { fill: "rgba(255, 80, 10, 0.15)", stroke: null },
        1: { fill: "rgba(200, 70, 0, 0.15)", stroke: null },
        2: { fill: "rgba(77, 233, 242, 0.2)", stroke: null },
        3: { fill: "rgba(255, 0, 0, 0.2)", stroke: null },
        4: { fill: "rgba(255, 255, 0, 0.2)", stroke: null },
        5: { fill: "rgba(153, 62, 6, 0.2)", stroke: null },
        6: { fill: "rgba(76, 240, 161, 0.25)", stroke: "rgba(51, 161, 118, 0.25)" },
        7: { fill: "rgba(142, 129, 38, 0.15)", stroke: "rgba(104, 95, 28, 0.15)" },
        8: { fill: "rgba(174, 137, 185, 0.25)", stroke: null },
        9: { fill: "rgba(225, 225, 0, 0.1)", stroke: null },
        10: { fill: "rgba(0, 0, 0, 0.2)", stroke: null },
        13: { fill: "rgba(255, 128, 189, 0.25)", stroke: null },
        14: { fill: "rgba(161, 132, 70, 0.2)", stroke: null },
        16: { fill: "rgba(109, 109, 255, 0.2)", stroke: null },
        18: { fill: "rgba(255, 250, 134, 0.15)", stroke: null },
        19: { fill: "rgba(146, 107, 227, 0.15)", stroke: null },
        20: { fill: "rgba(97, 97, 97, 0.2)", stroke: null },
        21: { fill: "rgba(228, 0, 0, 0.15)", stroke: null },
        22: { fill: "rgba(254, 0, 0, 0.15)", stroke: null },
        23: { fill: "rgba(0, 200, 255, 0.15)", stroke: null },
        24: { fill: "rgba(60, 0, 114, 0.15)", stroke: null },
        25: { fill: "rgba(210, 228, 238, 0.2)", stroke: null },
        26: { fill: "rgba(58, 116, 112, 0.3)", stroke: null },
        27: { fill: "rgba(33, 161, 164, 0.3)", stroke: null },
        28: { fill: "rgba(254, 191, 206, 0.5)", stroke: null },
        29: { fill: "rgba(77, 1, 98, 0.3)", stroke: null },
        30: { fill: "rgba(0, 198, 0, 0.2)", stroke: null },
        31: { fill: "rgba(189, 103, 209, 0.25)", stroke: null },
        32: { fill: "rgba(100, 35, 115, 0.3)", stroke: null },
        33: { fill: "rgba(246, 131, 6, 0.3)", stroke: null },
        34: { fill: "rgba(107, 84, 30, 0.3)", stroke: null },
        35: { fill: "rgba(152, 153, 153, 0.2)", stroke: null },
        36: { fill: "rgba(41, 254, 198, 0.3)", stroke: null },
        37: { fill: "rgba(45, 50, 54, 0.15)", stroke: null },
        38: { fill: "rgba(59, 0, 0, 0.2)", stroke: null },
        39: { fill: "rgba(190, 82, 19, 0.3)", stroke: null },
        41: { fill: "rgba(38, 18, 53, 0.15)", stroke: null },
        42: { fill: "rgba(117, 38, 86, 0.15)", stroke: null },
        43: { fill: "rgba(60, 189, 152, 0.2)", stroke: null },
        44: { fill: "rgba(207, 166, 236, 0.25)", stroke: null },
        45: { fill: "rgba(99, 93, 110, 0.35)", stroke: null },
        46: { fill: "rgba(110, 57, 30, 0.15)", stroke: null },
        47: { fill: "rgba(0, 225, 225, 0.1)", stroke: null },
        48: { fill: "rgba(255, 0, 0, 0.15)", stroke: null },
        49: { fill: "rgba(0, 0, 255, 0.15)", stroke: null },
        50: { fill: "rgba(60, 0, 115, 0.15)", stroke: null },
        51: { fill: "rgba(210, 228, 239, 0.2)", stroke: null },
        52: { fill: "rgba(58, 117, 112, 0.3)", stroke: null },
        53: { fill: "rgba(33, 161, 165, 0.3)", stroke: null },
        54: { fill: "rgba(255, 191, 206, 0.5)", stroke: null },
        55: { fill: "rgba(60, 0, 0, 0.2)", stroke: null },
        56: { fill: "rgba(77, 1, 99, 0.3)", stroke: null },
        57: { fill: "rgba(0, 199, 0, 0.2)", stroke: null },
        58: { fill: "rgba(189, 103, 210, 0.25)", stroke: null },
        59: { fill: "rgba(100, 35, 116, 0.3)", stroke: null },
        60: { fill: "rgba(247, 131, 6, 0.3)", stroke: null },
        61: { fill: "rgba(146, 107, 227, 0.3)", stroke: null },
        62: { fill: "rgba(214, 0, 57, 0.3)", stroke: null },
        63: { fill: "rgba(108, 84, 30, 0.3)", stroke: null },
        64: { fill: "rgba(153, 153, 153, 0.2)", stroke: null },
        65: { fill: "rgba(41, 255, 198, 0.3)", stroke: null },
        66: { fill: "rgba(45, 50, 55, 0.15)", stroke: null },
        67: { fill: "rgba(191, 82, 19, 0.3)", stroke: null },
        68: { fill: "rgba(170, 47, 47, 0.48)", stroke: null },
        69: { fill: "rgba(70, 65, 66, 0.17)", stroke: null },
        70: { fill: "rgba(117, 38, 86, 0.15)", stroke: null },
        71: { fill: "rgba(38, 18, 53, 0.15)", stroke: null },
        72: { fill: "rgba(255, 128, 0, 0.15)", stroke: null },
        73: { fill: "rgba(0, 255, 0, 0.6)", stroke: null }
    };

    // ==================== УПРАВЛЕНИЕ ХУКАМИ ====================
    let isOverlayEnabled = true;
    let isHideOriginalEnabled = false;
    let isHideSelfEnabled = false;
    let isUIVisible = true;
    let isExtrapolationEnabled = true;

    let currentArea = null;
    let originalProps = new Map();
    let originalSelfProps = null;
    let ballVelocities = new Map();
    let ballAuras = new Map();
    let gloopOriginalRenders = new Map();   // сохранение оригинальных render для Gloop

    // ========== 1. ХУК ДВИЖКА QUESTS-LAUNCHER ЧЕРЕЗ FIBER ==========
    function getGameRef() {
        try {
            const el = document.querySelector('div.quests-launcher');
            if (!el) return null;
            const reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            if (!reactKey) return null;

            let fiber = el[reactKey];
            let depth = 0;
            while (fiber && depth < 25) {
                if (fiber.stateNode?.gameState?.areaInfo?.self?.entity) {
                    const stateNode = fiber.stateNode;
                    return {
                        player: stateNode.gameState.areaInfo.self.entity,
                        camera: stateNode.renderer?.camera,
                        area: stateNode.gameState.area,
                        gameState: stateNode.gameState
                    };
                }
                fiber = fiber.return;
                depth++;
            }
        } catch (e) {}
        return null;
    }

    // ========== 2. ДИНАМИЧЕСКИЙ РАСЧЕТ СКОРОСТИ ==========
    function getBallTrackedState(id, currentX, currentY, now, type) {
        let state = ballVelocities.get(id);
        if (!state) {
            state = {
                vx: 0,
                vy: 0,
                lastX: currentX,
                lastY: currentY,
                updatedAt: now,
                visualX: currentX,
                visualY: currentY,
                lastFrameAt: now
            };
            ballVelocities.set(id, state);
            return state;
        }

        if (currentX !== state.lastX || currentY !== state.lastY) {
            const dt = (now - state.updatedAt) / 1000;

            if (dt > 0.005 && dt < 0.5) {
                const rawVx = (currentX - state.lastX) / dt;
                const rawVy = (currentY - state.lastY) / dt;

                if (canBounce(type)) {
                    if (Math.sign(rawVx) !== Math.sign(state.vx) && Math.abs(rawVx) > 10) {
                        state.vx = rawVx;
                    } else {
                        const filter = 0.15;
                        state.vx = state.vx * (1 - filter) + rawVx * filter;
                    }

                    if (Math.sign(rawVy) !== Math.sign(state.vy) && Math.abs(rawVy) > 10) {
                        state.vy = rawVy;
                    } else {
                        const filter = 0.15;
                        state.vy = state.vy * (1 - filter) + rawVy * filter;
                    }
                } else {
                    const filter = 0.15;
                    state.vx = state.vx * (1 - filter) + rawVx * filter;
                    state.vy = state.vy * (1 - filter) + rawVy * filter;
                }

                const speed = Math.hypot(state.vx, state.vy);
                if (speed > 2500) {
                    state.vx = (state.vx / speed) * 2500;
                    state.vy = (state.vy / speed) * 2500;
                }
            }
            state.lastX = currentX;
            state.lastY = currentY;
            state.updatedAt = now;
        }
        return state;
    }

    function getZoneBounds(x, y, area) {
        if (area && area.zones) {
            try {
                const zonesList = typeof area.zones.list === 'function' ? area.zones.list() : (Array.isArray(area.zones) ? area.zones : []);
                for (const zone of zonesList) {
                    if (x >= zone.x && x <= zone.x + zone.width &&
                        y >= zone.y && y <= zone.y + zone.height) {
                        return { minX: zone.x, maxX: zone.x + zone.width, minY: zone.y, maxY: zone.y + zone.height };
                    }
                }
            } catch (e) {}
        }
        if (area && area.width && area.height) {
            return { minX: 0, maxX: area.width, minY: 0, maxY: area.height };
        }
        return null;
    }

    // ========== СБОР АУР И ОФФСЕТОВ GLOOP ==========
    function cacheIncomingAuras(game) {
        if (!game?.gameState?.entities) return;

        // === Собираем живые куски Gloop (только серверный inactive) ===
        window.__gloopOffsets = [];
        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (entity.entityType !== 136) continue;
            if (entity.inactive !== true) {
                window.__gloopOffsets.push({
                    x: entity.x,
                    y: entity.y,
                    radius: entity.radius || 3,
                    color: entity.color || '#7aff7a'
                });
            }
        }

        // === Сбор аур ===
        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            let effs = null;
            if (originalProps.has(id) && originalProps.get(id).hasEffects) {
                effs = originalProps.get(id).effectsData;
            } else if (entity.effects && entity.effects.effects) {
                effs = entity.effects.effects;
            }

            if (effs) {
                const activeAurasForBall = {};
                let hasEffects = false;
                for (const key in effs) {
                    if (Object.prototype.hasOwnProperty.call(effs, key)) {
                        const auraData = effs[key];
                        if (!auraData) continue;
                        const auraType = auraData.effectType !== undefined ? auraData.effectType : auraData.type;
                        const r = auraData.radius || auraData.currentRadius || auraData.range || auraData.auraRadius;
                        if (auraType !== undefined && r !== undefined) {
                            activeAurasForBall[auraType] = r;
                            hasEffects = true;
                        }
                    }
                }
                if (hasEffects) {
                    ballAuras.set(id, activeAurasForBall);
                } else {
                    ballAuras.delete(id);
                }
            } else {
                ballAuras.delete(id);
            }
        }
    }

    // ========== 3. СБОР ДАННЫХ И СОРТИРОВКА СЛОЕВ ==========
    function getAllBalls(gameState, player, now) {
        const balls = [];
        if (!gameState?.entities || !player) return balls;

        for (const [id, entity] of Object.entries(gameState.entities)) {
            if (id === gameState.selfId) continue;
            if (entity.nick !== undefined || entity.entityType === 118 || entity.entityType === 113) continue;
            if ((entity.name || '').toLowerCase().includes('switch') || entity.entityType === 130) continue;

            if (entity.entityType === 136) continue;   // Gloop рисуем отдельно

            if (entity.radius && entity.radius > 0) {
                let alpha = 1;

                if (!isHideOriginalEnabled) {
                    if (entity.currentTransparency !== undefined && entity.currentTransparency < 1) {
                        alpha = entity.currentTransparency;
                    } else if (entity.alpha !== undefined && entity.alpha < 1) {
                        alpha = entity.alpha;
                    }
                }

                const name = (entity.name || '').toLowerCase();
                if (name.includes('ghost')) alpha = GHOST_ALPHA;
                else if (entity.harmless === 1 || entity.isHarmless === true || entity.harmlessTime > 0) alpha = HARMLESS_ALPHA;
                else if (entity.grassHarmless === true || entity.grassharmless === true) alpha = GRASSHARMLESS_ALPHA;

                const type = entity.entityType !== undefined ? entity.entityType : entity.type;
                const trackedState = getBallTrackedState(id, entity.x, entity.y, now, type);
                const hasVelocity = Math.abs(trackedState.vx) > 10 || Math.abs(trackedState.vy) > 10;

                balls.push({
                    id: id,
                    rawX: entity.x,
                    rawY: entity.y,
                    radius: entity.radius,
                    color: entity.color || '#FFFFFF',
                    type: type,
                    alpha: alpha,
                    isType59: type === 59,
                    isType52: type === 52,
                    isDripping: name.includes('drip'),
                    hasVelocity: hasVelocity,
                    trackedState: trackedState
                });
            }
        }

        balls.sort((a, b) => {
            if (a.isType59 && !b.isType59) return -1;
            if (!a.isType59 && b.isType59) return 1;
            if (a.isType52 && !b.isType52) return 1;
            if (!a.isType52 && b.isType52) return -1;
            return b.radius - a.radius;
        });

        return balls;
    }

    function getStrokeColor(ball) {
        if (ball.type === 136) return 'transparent';
        if (ball.isType52) return 'transparent';
        if ([74, 227, 228, 229].includes(ball.type)) return 'white';
        if (ball.color === '#000000' || ball.color === '#222222' || ball.isDripping) return 'white';
        return 'black';
    }

    // ========== 4. ОТРИСОВКА ==========
    function drawBalls(nativeCtx, game, camera, now) {
        const gameState = game.gameState;
        const player = game.player;
        const canvas = nativeCtx.canvas;

        if (!gameState || !camera || !player) return;

        if (gameState.performanceStats && gameState.performanceStats.pingSamples) {
            const samples = gameState.performanceStats.pingSamples;
            if (samples.length >= 5) {
                const lastFive = samples.slice(-5);
                const sum = lastFive.reduce((s, sample) => s + sample.value, 0);
                const avgPing = sum / 5;
                const ticksFromPing = avgPing / 16.66;
                const newTicks = Math.ceil(ticksFromPing + 1);
                if (newTicks >= 0) {
                    EXTRAPOLATION_TICKS = newTicks;
                }
            }
        }

        const balls = getAllBalls(gameState, player, now);

        const scale = camera.originalGameScale || camera.scale || 1;
        const left = camera.left || (camera.x - canvas.width / (2 * scale));
        const top = camera.top || (camera.y - canvas.height / (2 * scale));

        // Helper: world coords to screen coords
        function worldToScreen(wx, wy) {
            return {
                x: (wx - left) * scale,
                y: (wy - top) * scale
            };
        }

        for (const ball of balls) {
            const state = ball.trackedState;
            if (!state) continue;

            if (!state.lastFrameAt) state.lastFrameAt = now;
            const frameDt = Math.min(0.1, (now - state.lastFrameAt) / 1000);
            state.lastFrameAt = now;

            let targetX = ball.rawX;
            let targetY = ball.rawY;
            const timeSincePacket = Math.min(0.1, (now - state.updatedAt) / 1000);

            if (ball.type === 199 || ball.type === 207) {
                state.visualX = ball.rawX;
                state.visualY = ball.rawY;
            } else {
                if (isExtrapolationEnabled && ball.hasVelocity) {
                    const totalPredictionSec = timeSincePacket + (EXTRAPOLATION_TICKS * TICK_MS / 1000);
                    targetX += state.vx * totalPredictionSec;
                    targetY += state.vy * totalPredictionSec;
                } else if (ball.hasVelocity) {
                    targetX += state.vx * timeSincePacket;
                    targetY += state.vy * timeSincePacket;
                }

                const bounds = getZoneBounds(ball.rawX, ball.rawY, game.area);
                if (bounds) {
                    const radius = ball.radius || 0;
                    if (canBounce(ball.type)) {
                        if (targetX - radius < bounds.minX) {
                            targetX = bounds.minX + radius + (bounds.minX - (targetX - radius));
                        } else if (targetX + radius > bounds.maxX) {
                            targetX = bounds.maxX - radius - ((targetX + radius) - bounds.maxX);
                        }
                        if (targetY - radius < bounds.minY) {
                            targetY = bounds.minY + radius + (bounds.minY - (targetY - radius));
                        } else if (targetY + radius > bounds.maxY) {
                            targetY = bounds.maxY - radius - ((targetY + radius) - bounds.maxY);
                        }
                    } else if (DEFAULT_PROJECTILES.has(ball.type)) {
                        let hitWall = false;
                        if (targetX - radius < bounds.minX) { targetX = bounds.minX + radius; hitWall = true; }
                        else if (targetX + radius > bounds.maxX) { targetX = bounds.maxX - radius; hitWall = true; }
                        if (targetY - radius < bounds.minY) { targetY = bounds.minY + radius; hitWall = true; }
                        else if (targetY + radius > bounds.maxY) { targetY = bounds.maxY - radius; hitWall = true; }
                        if (hitWall) {
                            state.vx = 0;
                            state.vy = 0;
                            ball.hasVelocity = false;
                        }
                    }
                }

                if (Math.hypot(targetX - state.visualX, targetY - state.visualY) > 200) {
                    state.visualX = targetX;
                    state.visualY = targetY;
                } else {
                    const k = 25;
                    const lerpFactor = Math.min(1, k * frameDt);
                    state.visualX += (targetX - state.visualX) * lerpFactor;
                    state.visualY += (targetY - state.visualY) * lerpFactor;
                }

                if (bounds && (canBounce(ball.type) || DEFAULT_PROJECTILES.has(ball.type))) {
                    const radius = ball.radius || 0;
                    if (state.visualX - radius < bounds.minX) state.visualX = bounds.minX + radius;
                    if (state.visualX + radius > bounds.maxX) state.visualX = bounds.maxX - radius;
                    if (state.visualY - radius < bounds.minY) state.visualY = bounds.minY + radius;
                    if (state.visualY + radius > bounds.maxY) state.visualY = bounds.maxY - radius;
                }
            }

            // Convert to screen coordinates
            const screen = worldToScreen(state.visualX, state.visualY);
            const screenRadius = Math.max(3, ball.radius * scale);

            // Draw auras
            const auras = ballAuras.get(ball.id);
            if (auras) {
                for (const [auraIdStr, auraRadius] of Object.entries(auras)) {
                    const auraId = parseInt(auraIdStr, 10);
                    let colorConfig = AURA_COLORS[auraId];
                    if (!colorConfig) {
                        colorConfig = { fill: "rgba(255, 0, 150, 0.25)", stroke: "rgba(255, 0, 150, 0.8)" };
                    }
                    nativeCtx.save();
                    nativeCtx.globalAlpha = 1.0;
                    nativeCtx.beginPath();
                    nativeCtx.arc(screen.x, screen.y, auraRadius * scale, 0, Math.PI * 2);
                    if (colorConfig.fill) {
                        nativeCtx.fillStyle = colorConfig.fill;
                        nativeCtx.fill();
                    }
                    if (colorConfig.stroke) {
                        nativeCtx.strokeStyle = colorConfig.stroke;
                        nativeCtx.lineWidth = 1.5;
                        nativeCtx.stroke();
                    }
                    nativeCtx.restore();
                }
            }

            // Draw ball
            const strokeColor = getStrokeColor(ball);
            nativeCtx.save();
            nativeCtx.globalAlpha = ball.alpha;
            nativeCtx.beginPath();
            nativeCtx.arc(screen.x, screen.y, screenRadius, 0, Math.PI * 2);
            nativeCtx.fillStyle = ball.color;
            nativeCtx.fill();
            if (strokeColor !== 'transparent') {
                nativeCtx.strokeStyle = strokeColor;
                nativeCtx.lineWidth = STROKE_WIDTH;
                nativeCtx.stroke();
            }
            nativeCtx.restore();
        }

        // --- 2. Отрисовка кусочков Gloop с привязкой к предикту камеры ---
        if (window.__gloopOffsets && window.__gloopOffsets.length > 0) {
            const pd = window.__predictData;
            const predX = (pd && (now - pd.time) < 100) ? pd.x : player.x;
            const predY = (pd && (now - pd.time) < 100) ? pd.y : player.y;

            for (const piece of window.__gloopOffsets) {
                const dx = piece.x - player.x;
                const dy = piece.y - player.y;
                const worldX = predX + dx;
                const worldY = predY + dy;

                const screen = worldToScreen(worldX, worldY);
                const screenRadius = Math.max(3, piece.radius * scale);

                nativeCtx.save();
                nativeCtx.globalAlpha = 1;
                nativeCtx.beginPath();
                nativeCtx.arc(screen.x, screen.y, screenRadius, 0, Math.PI * 2);
                nativeCtx.fillStyle = piece.color;
                nativeCtx.fill();
                nativeCtx.restore();
            }
        }
        // --- 3. Рендер игрока ---
        const playerRadius = (player.radius || DEFAULT_PLAYER_RADIUS) * scale;
        nativeCtx.globalAlpha = PLAYER_ALPHA;
        nativeCtx.beginPath();
        nativeCtx.arc(canvas.width / 2, canvas.height / 2, playerRadius, 0, Math.PI * 2);
        if (player.isEmberInvulnerable) {
            nativeCtx.fillStyle = '#000000';
        } else {
            nativeCtx.fillStyle = player.color || '#00ff88';
        }
        nativeCtx.fill();
        nativeCtx.globalAlpha = 1;

        let playerStrokeWidth = 2;
        let playerStrokeColor = '#ffffff';
        if (player.isBandaged === true) {
            playerStrokeWidth = 5;
        }
        if (player.isUnbandaging === true) {
            playerStrokeWidth = 5;
            playerStrokeColor = '#ff0000';
        }
        nativeCtx.beginPath();
        nativeCtx.arc(canvas.width / 2, canvas.height / 2, playerRadius, 0, Math.PI * 2);
        nativeCtx.strokeStyle = playerStrokeColor;
        nativeCtx.lineWidth = playerStrokeWidth;
        nativeCtx.stroke();

        if (typeof extrapolateBtn !== 'undefined') {
            extrapolateBtn.innerHTML = `🔮 ${EXTRAPOLATION_TICKS} TICKS [${isExtrapolationEnabled ? 'ON' : 'OFF'}]`;
        }
    }

    // ========== 5. СИНХРОННЫЕ МОДИФИКАТОРЫ ВИДИМОСТИ ==========
    function updateSelfVisibility(game) {
        const gameState = game?.gameState;
        if (!gameState?.entities || !gameState.selfId) return;
        const selfEntity = gameState.entities[gameState.selfId];
        if (!selfEntity) return;
        if (isHideSelfEnabled) {
            if (!originalSelfProps) originalSelfProps = { isDeparted: selfEntity.isDeparted };
            selfEntity.isDeparted = true;
        } else if (originalSelfProps) {
            selfEntity.isDeparted = originalSelfProps.isDeparted;
            originalSelfProps = null;
        }
    }

    function hideOriginalBalls(game) {
        if (!game?.gameState?.entities) return;
        const selfId = game.gameState.selfId;

        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (entity.nick !== undefined || entity.entityType === 118 || entity.entityType === 113 || entity.id === selfId) continue;
            if (entity.entityType === 130 || (entity.name || '').toLowerCase().includes('switch')) continue;

            // Скрытие Gloop: ломаем render
            if (entity.entityType === 136) {
                if (!gloopOriginalRenders.has(id)) {
                    gloopOriginalRenders.set(id, entity.render);
                }
                entity.render = () => {};
                continue;
            }

            if (!entity.radius || entity.radius <= 0) continue;

            // Сохраняем эффекты для аур
            if (!originalProps.has(id)) {
                let hasEffects = false;
                let savedEffects = null;
                let savedFillColor = null;
                if (entity.effects) {
                    if (entity.effects.effects) {
                        hasEffects = true;
                        savedEffects = JSON.parse(JSON.stringify(entity.effects.effects));
                    }
                    if (entity.effects.fillColor) {
                        savedFillColor = entity.effects.fillColor;
                    }
                }
                originalProps.set(id, {
                    hasEffects: hasEffects,
                    effectsData: savedEffects,
                    fillColor: savedFillColor,
                    isDestroyed: entity.isDestroyed,
                    isDeparted: entity.isDeparted
                });

                // 🔽 СОХРАНЯЕМ ДЛЯ ПРЕДИКТА КАМЕРЫ
                if (!window.__originalEffects) window.__originalEffects = new Map();
                window.__originalEffects.set(id, savedEffects);
            }

            entity.isDestroyed = true;
            entity.isDeparted = true;

            if (entity.effects) {
                if (entity.effects.effects && typeof entity.effects.effects === 'object') {
                    entity.effects.effects = {};
                }
                if (entity.effects.fillColor) {
                    entity.effects.fillColor = 'rgba(0, 0, 0, 0)';
                }
            }
        }
    }
    function restoreOriginalBalls(game) {
        if (!game?.gameState?.entities) return;

        // Восстанавливаем render для Gloop
        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (entity.entityType === 136 && gloopOriginalRenders.has(id)) {
                entity.render = gloopOriginalRenders.get(id);
            }
        }
        gloopOriginalRenders.clear();

        // Обычные враги
        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (originalProps.has(id)) {
                const orig = originalProps.get(id);
                entity.isDestroyed = orig.isDestroyed;
                entity.isDeparted = orig.isDeparted;

                if (orig.hasEffects && entity.effects) {
                    entity.effects.effects = orig.effectsData;
                }
                if (orig.fillColor && entity.effects) {
                    entity.effects.fillColor = orig.fillColor;
                }
            }
        }
        originalProps.clear();
        if (window.__originalEffects) window.__originalEffects.clear();
    }

    // ========== 6. ИНЪЕКЦИЯ В AREA ==========
    function runRenderHook() {
        const game = getGameRef();
        if (!game || !game.area || !game.camera) return;

        if (currentArea !== game.area) {
            // Восстанавливаем все сломанные render перед сменой зоны
            for (const [id, origRender] of gloopOriginalRenders.entries()) {
                const liveGame = getGameRef();
                if (liveGame?.gameState?.entities?.[id]) {
                    liveGame.gameState.entities[id].render = origRender;
                }
            }
            gloopOriginalRenders.clear();

            currentArea = game.area;
            ballVelocities.clear();
            ballAuras.clear();
            originalProps.clear();
            window.__gloopOffsets = [];
        }

        if (currentArea && !currentArea._originalRender) {
            currentArea._originalRender = currentArea.render;

            currentArea.render = function(nativeCtx, cam) {
                const liveGame = getGameRef();

                cacheIncomingAuras(liveGame);
                updateSelfVisibility(liveGame);

                if (isHideOriginalEnabled) hideOriginalBalls(liveGame);
                else restoreOriginalBalls(liveGame);

                const result = this._originalRender.call(this, nativeCtx, cam);

                if (isOverlayEnabled) {
                    drawBalls(nativeCtx, liveGame, cam, performance.now());
                }

                return result;
            };
        }
    }

    function createBtn(bottom, text, color, onClick) {
        const btn = document.createElement('div');
        btn.style.cssText = `position: fixed; bottom: ${bottom}px; left: 10px; background: rgba(0,0,0,0.85); color: ${color}; font-family: monospace; font-size: 11px; padding: 6px 10px; border-radius: 6px; z-index: 1000000; cursor: pointer; border: 1px solid ${color}; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none;`;
        btn.innerHTML = text;
        btn.onclick = onClick;
        // Запрет выделения текста при двойном клике
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(btn);
        return btn;
    }

    const overlayBtn = createBtn(60, '🎨 OVERLAY [ON]', '#0f0', () => {
        isOverlayEnabled = !isOverlayEnabled;
        overlayBtn.innerHTML = `🎨 OVERLAY [${isOverlayEnabled ? 'ON' : 'OFF'}]`;
        overlayBtn.style.borderColor = isOverlayEnabled ? '#0f0' : '#f00';
    });

    const hideBtn = createBtn(110, '👻 HIDE ORIGINALS [OFF]', '#0ff', () => {
        isHideOriginalEnabled = !isHideOriginalEnabled;
        hideBtn.innerHTML = `👻 HIDE ORIGINALS [${isHideOriginalEnabled ? 'ON' : 'OFF'}]`;
        hideBtn.style.borderColor = isHideOriginalEnabled ? '#f0f' : '#0ff';
    });

    const selfBtn = createBtn(160, '👤 HIDE SELF [OFF]', '#ffa', () => {
        isHideSelfEnabled = !isHideSelfEnabled;
        selfBtn.innerHTML = `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`;
        selfBtn.style.borderColor = isHideSelfEnabled ? '#f0f' : '#ffa';
    });

    const extrapolateBtn = createBtn(210, `🔮 ${EXTRAPOLATION_TICKS} TICKS [ON]`, '#f0f', () => {
        isExtrapolationEnabled = !isExtrapolationEnabled;
        extrapolateBtn.innerHTML = `🔮 ${EXTRAPOLATION_TICKS} TICKS [${isExtrapolationEnabled ? 'ON' : 'OFF'}]`;
        extrapolateBtn.style.borderColor = isExtrapolationEnabled ? '#f0f' : '#888';
        if (!isExtrapolationEnabled) ballVelocities.clear();
    });

    setInterval(() => {
        const game = getGameRef();
        if (game?.gameState?.entities) {
            const existingIds = new Set(Object.keys(game.gameState.entities));
            for (const [id] of ballVelocities) {
                if (!existingIds.has(id)) ballVelocities.delete(id);
            }
            for (const [id] of ballAuras) {
                if (!existingIds.has(id)) ballAuras.delete(id);
            }
        }
    }, 4000);

    window.addEventListener('keydown', (e) => {
        if (e.key === 'PageUp') {
            e.preventDefault();
            isUIVisible = !isUIVisible;
            [overlayBtn, hideBtn, selfBtn, extrapolateBtn].forEach(b => b.style.display = isUIVisible ? 'block' : 'none');
        }
    });

    setInterval(runRenderHook, 32);
})();