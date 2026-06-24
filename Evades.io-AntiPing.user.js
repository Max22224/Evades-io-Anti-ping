// ==UserScript==
// @name         Evades.io - Anti Ping Main
// @namespace    https://evades.io/
// @version      7.0.0
// @description  Anti ping for Evades.io
// @match        https://*.evades.io/*
// @match        https://*.evades.online/*
// @run-at       document-end
// @downloadURL https://raw.githubusercontent.com/Max22224/Evades-io-Anti-ping/main/Evades.io-AntiPing.user.js
// @updateURL   https://raw.githubusercontent.com/Max22224/Evades-io-Anti-ping/main/Evades.io-AntiPing.user.js
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    // ==================== GRAPHICS SETTINGS ====================
    const DEFAULT_PLAYER_RADIUS = 15;
    const PLAYER_ALPHA = 0.7;

    // ==================== EXTRAPOLATION SETTINGS ====================
    const SERVER_TICK_MS = 1000 / 60;
    const CLONE_OFFSET = 10000000; // Offset to handle entity id === 0 correctly

    // ==================== BALL TYPE CONFIGURATION ====================
    const _ignoredTypes = new Set([62, 72, 199, 8, 113, 228, 136]);

    // ==================== Main Input / Output Hook ====================
    window._client = window._client || {};
    Object.assign(window._client, {
        seqQueue: [],
        selfCmdHistory: [],
        selfAcked: null,
        ping: 0,
        pingHistory: [],
        unlockFPS: false
    });

    let _obs = new MutationObserver((ev) => {
        let elem = Array.from(document.querySelectorAll('script')).filter(a => a.type === "module" && a.src.match(/\/index\.[0-9a-f]{8}\.js/))[0];
        if (!elem) return;
        let src = elem.src;

        if (!navigator.userAgent.includes("Firefox")) elem.remove();

        let req = new XMLHttpRequest();
        req.open("GET", src, false);
        req.send();
        let code = req.response;
        code = code
            .replace(/processServerMessage\(([^)]+)\)\{/, (m, msgVar) => `processServerMessage(${msgVar}){
        try {
            window._client && window._client.onMessage && window._client.onMessage(${msgVar});
        } catch(e){ }`)

            .replace(/ag\.emit\(([^)]+)\)/, (m, msgVar) => `(window._client && window._client.input && window._client.input(${msgVar}), ag.emit(${msgVar}))`)
            .replace("this.gameState.packetNumber===this.lastRenderedPacket", a => "this.gameState.packetNumber===this.lastRenderedPacket && !window._client.unlockFPS")

        let nScr = document.createElement("script");
        nScr.setAttribute("type", "module");
        nScr.innerHTML = code;
        setTimeout(() => {
            document.body.appendChild(nScr);
        }, 100); // Delay to ensure the original script is removed before adding the modified one
        console.log("Init");
        _obs.disconnect();
    });
    _obs.observe(document, { childList: true, subtree: true });

    // ==================== MSG EVENT LOGIC FUNCTIONS ====================
    window._client.input = (msg) => {
        if (msg.sequence) {
            window._client.seqQueue.push([msg.sequence, +new Date()]);

            if (msg.mouseDown && msg.mouseDown.updated) {
                window._client.selfCmdHistory = window._client.selfCmdHistory || [];
                window._client.selfCmdHistory.push({
                    seq: msg.sequence,
                    x: msg.mouseDown.x,
                    y: msg.mouseDown.y,
                    time: performance.now()
                });

                if (window._client.selfCmdHistory.length > 20) {
                    window._client.selfCmdHistory.shift();
                }
            }
        }
        return msg;
    };

    window._client.onMessage = (msg) => {
        if (!msg.entities) msg.entities = [];

        const game = getGameRef();
        let me = msg?.globalEntities?.find(e => e.id === game?.gameState?.selfId);

        if (me) {
            if (msg.sequence != null && typeof me.x === 'number' && typeof me.y === 'number') {
                window._client.selfAcked = {
                    seq: msg.sequence,
                    x: me.x,
                    y: me.y,
                    time: performance.now()
                };
            }
        }

        if (msg.sequence != null && window._client.selfCmdHistory) {
            window._client.selfCmdHistory = window._client.selfCmdHistory.filter(
                cmd => cmd.seq > msg.sequence
            );
        }
        let _seq = window._client.seqQueue.find(q => q[0] === msg.sequence);
        if (_seq) {
            const rawPing = +new Date() - _seq[1];

            window._client.pingHistory.push(rawPing);
            if (window._client.pingHistory.length > 8) {
                window._client.pingHistory.shift();
            }

            const sum = window._client.pingHistory.reduce((a, b) => a + b, 0);
            window._client.ping = Math.round(sum / window._client.pingHistory.length * 100) / 100;

            window._client.seqQueue = window._client.seqQueue.filter(q => q[0] > msg.sequence);
        }

        if (msg.pong) return; // Skip ping messages
        if (!isOverlayEnabled) return;
        if (msg.area) {
            window._client.selfCmdHistory = []; // Clear command history on area change
            if (game?.gameState?.entities) {
                for (const id of Object.keys(game.gameState.entities)) {
                    if (Number(id) < 0) {
                        delete game.gameState.entities[id];
                    }
                }
            }
        }

        injectEnemies(msg);
    };

    // ==================== HOOK MANAGEMENT ====================
    let isOverlayEnabled = true;
    let isHideOriginalEnabled = true;
    let isHideSelfEnabled = false;
    let isPredictPlayerEnabled = true;
    let isUIVisible = true;

    let currentArea = null;
    let originalProps = new Map();
    let originalVisibility = new Map();
    let originalSelfProps = null;
    let gloopOriginalRenders = new Map();

    // ==================== CONFIG & GLOBALS FOR PREDICTION ====================
    const config = {
        bounceDetectAngle: Math.PI / 3,
        enemyEmaAlpha: 0.15,
        enemyStoppedMs: 300,
        bounceSimStepMs: 12,
    };

    const ENEMY_TYPE_WALL = 229;

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
        } catch (e) { }
        return null;
    }

    function updateEnemyPrediction(enemies) {
        const now = performance.now();
        const basePredMs = (window._client.ping || 0) * 0.5 + SERVER_TICK_MS;
        const hybridPredMs = (window.__enemySmoothPendingTicks > 0 ? window.__enemySmoothPendingTicks * SERVER_TICK_MS : basePredMs);
        const predMs = hybridPredMs;
        for (const e of enemies) {
            if (!e._evadeLastPos) {
                e._evadeLastPos = { x: e.x, y: e.y };
                e._evadeLastTime = now;
                e._vxMs = 0;
                e._vyMs = 0;
                e._speedMs = 0;
                e._fx = e.x;
                e._fy = e.y;
                e._predX = e.x;
                e._predY = e.y;
                continue;
            }

            const moved = (e.x !== e._evadeLastPos.x || e.y !== e._evadeLastPos.y);
            if (moved) {
                const wallClockDt = now - e._evadeLastTime;
                const numTicks = Math.max(1, Math.round(wallClockDt / SERVER_TICK_MS));
                const effectiveDt = numTicks * SERVER_TICK_MS;
                if (effectiveDt > 0.5) {
                    const rawVxMs = (e.x - e._evadeLastPos.x) / effectiveDt;
                    const rawVyMs = (e.y - e._evadeLastPos.y) / effectiveDt;
                    const rawSpeed = Math.hypot(rawVxMs, rawVyMs);

                    if (rawSpeed > 1.5) {
                        e._vxMs = 0;
                        e._vyMs = 0;
                        e._trajectory = null;
                        e._trajValid = false;
                    } else {
                        const emaSpeed = Math.hypot(e._vxMs, e._vyMs);
                        let isBounce = false;

                        if (rawSpeed > 0.001 && emaSpeed > 0.001) {
                            const dot = (rawVxMs * e._vxMs + rawVyMs * e._vyMs) / (rawSpeed * emaSpeed);
                            const angleDiff = Math.acos(Math.max(-1, Math.min(1, dot)));
                            isBounce = angleDiff > config.bounceDetectAngle;
                        }

                        if (isBounce) {
                            e._vxMs = rawVxMs;
                            e._vyMs = rawVyMs;
                            e._trajectory = null;
                        } else {
                            e._vxMs = e._vxMs * (1 - config.enemyEmaAlpha) + rawVxMs * config.enemyEmaAlpha;
                            e._vyMs = e._vyMs * (1 - config.enemyEmaAlpha) + rawVyMs * config.enemyEmaAlpha;
                        }
                    }

                    e._evadeLastPos.x = e.x;
                    e._evadeLastPos.y = e.y;
                    e._evadeLastTime = now;
                }
            } else if (now - e._evadeLastTime > config.enemyStoppedMs) {
                e._vxMs = 0;
                e._vyMs = 0;
            }

            e._speedMs = Math.hypot(e._vxMs, e._vyMs);
            const msSinceTick = now - e._evadeLastTime;
            e._fx = e.x + (e._vxMs || 0) * msSinceTick;
            e._fy = e.y + (e._vyMs || 0) * msSinceTick;

            e._predX = e._fx + e._vxMs * predMs;
            e._predY = e._fy + e._vyMs * predMs;
        }
    }

    function simulateWallHuggingTrajectory(e, maxTimeMs, bounceZones) {
        const stepMs = config.bounceSimStepMs || 16;
        const eR = e.radius;
        let x = e.x, y = e.y;
        let vx = e._vxMs || 0, vy = e._vyMs || 0;

        if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) return [{ t: 0, x, y }, { t: maxTimeMs, x, y }];

        let zone = null;
        for (const z of bounceZones) {
            if (x >= z.x && x <= z.x + z.width && y >= z.y && y <= z.y + z.height) { zone = z; break; }
        }
        if (!zone) return [{ t: 0, x, y }, { t: maxTimeMs, x: x + vx * maxTimeMs, y: y + vy * maxTimeMs }];

        const bLeft = zone.x + eR, bRight = zone.x + zone.width - eR;
        const bTop = zone.y + eR, bBottom = zone.y + zone.height - eR;
        const speed = Math.hypot(vx, vy);

        if (Math.abs(vx) >= Math.abs(vy)) { vx = Math.sign(vx || 1) * speed; vy = 0; }
        else { vy = Math.sign(vy || 1) * speed; vx = 0; }

        const tol = Math.max(eR * 0.5, 8);
        const onTop = Math.abs(y - bTop) < tol, onBottom = Math.abs(y - bBottom) < tol;
        const onLeft = Math.abs(x - bLeft) < tol, onRight = Math.abs(x - bRight) < tol;

        let clockwise = true;
        if (vx !== 0) {
            if (onTop) clockwise = (vx > 0); else if (onBottom) clockwise = (vx < 0);
        } else {
            if (onRight) clockwise = (vy > 0); else if (onLeft) clockwise = (vy < 0);
        }

        if (vx !== 0) {
            if (onTop) y = bTop;
            if (onBottom) y = bBottom;
        } else {
            if (onLeft) x = bLeft;
            if (onRight) x = bRight;
        }

        const points = [{ t: 0, x, y }];
        for (let t = stepMs; t <= maxTimeMs; t += stepMs) {
            let remaining = speed * stepMs, iter = 0;
            while (remaining > 0.01 && iter++ < 4) {
                const dx = vx !== 0 ? Math.sign(vx) : 0;
                const dy = vy !== 0 ? Math.sign(vy) : 0;
                let wallDist = Infinity;
                if (dx > 0) wallDist = bRight - x; else if (dx < 0) wallDist = x - bLeft;
                else if (dy > 0) wallDist = bBottom - y; else if (dy < 0) wallDist = y - bTop;
                if (wallDist < 0) wallDist = 0;

                if (remaining <= wallDist + 0.001) {
                    x += dx * remaining; y += dy * remaining; remaining = 0;
                } else {
                    x += dx * wallDist; y += dy * wallDist; remaining -= wallDist;
                    if (dx > 0) x = bRight; else if (dx < 0) x = bLeft;
                    else if (dy > 0) y = bBottom; else if (dy < 0) y = bTop;

                    if (clockwise) { const ov = vx; vx = -vy; vy = ov; }
                    else { const ov = vx; vx = vy; vy = -ov; }
                }
            }
            points.push({ t, x, y });
        }
        return points;
    }

    function simulateEnemyTrajectory(e, maxTimeMs, bounceZones) {
        if (e.entityType === ENEMY_TYPE_WALL) return simulateWallHuggingTrajectory(e, maxTimeMs, bounceZones);

        const eR = e.radius;
        let x = e.x, y = e.y, vx = e._vxMs || 0, vy = e._vyMs || 0;

        if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) return [{ t: 0, x, y }, { t: maxTimeMs, x, y }];

        let zone = null;
        for (const z of bounceZones) {
            if (x >= z.x && x <= z.x + z.width && y >= z.y && y <= z.y + z.height) { zone = z; break; }
        }
        if (!zone) return [{ t: 0, x, y }, { t: maxTimeMs, x: x + vx * maxTimeMs, y: y + vy * maxTimeMs }];

        const bLeft = zone.x + eR, bRight = zone.x + zone.width - eR;
        const bTop = zone.y + eR, bBottom = zone.y + zone.height - eR;

        x = Math.max(bLeft, Math.min(bRight, x));
        y = Math.max(bTop, Math.min(bBottom, y));
        if (x <= bLeft && vx < 0) vx = -vx; if (x >= bRight && vx > 0) vx = -vx;
        if (y <= bTop && vy < 0) vy = -vy; if (y >= bBottom && vy > 0) vy = -vy;

        const stepMs = config.bounceSimStepMs || 12;
        const points = [{ t: 0, x, y }];

        for (let t = stepMs; t <= maxTimeMs; t += stepMs) {
            let remaining = stepMs, iter = 0;
            while (remaining > 0.001 && iter++ < 6) {
                let tBounce = remaining;
                if (vx < 0) { const tw = (bLeft - x) / vx; if (tw > 1e-6 && tw < tBounce) tBounce = tw; }
                else if (vx > 0) { const tw = (bRight - x) / vx; if (tw > 1e-6 && tw < tBounce) tBounce = tw; }
                if (vy < 0) { const tw = (bTop - y) / vy; if (tw > 1e-6 && tw < tBounce) tBounce = tw; }
                else if (vy > 0) { const tw = (bBottom - y) / vy; if (tw > 1e-6 && tw < tBounce) tBounce = tw; }

                x += vx * tBounce; y += vy * tBounce; remaining -= tBounce;

                if (remaining > 0.001) {
                    if (x <= bLeft || x >= bRight) { vx = -vx; x = Math.max(bLeft, Math.min(bRight, x)); }
                    if (y <= bTop || y >= bBottom) { vy = -vy; y = Math.max(bTop, Math.min(bBottom, y)); }
                }
            }
            points.push({ t, x, y });
        }
        return points;
    }

    function interpolateTrajectory(traj, timeMs) {
        if (!traj || traj.length === 0) return null;
        if (timeMs <= 0) return { x: traj[0].x, y: traj[0].y };
        const last = traj[traj.length - 1];
        if (timeMs >= last.t) return { x: last.x, y: last.y };

        let lo = 0, hi = traj.length - 1;
        while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (traj[mid].t <= timeMs) lo = mid; else hi = mid; }

        const a = traj[lo], b = traj[hi];
        const dt = b.t - a.t;
        if (dt < 1e-6) return { x: a.x, y: a.y };
        const u = (timeMs - a.t) / dt;
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }

    function precomputeTrajectories(enemies, maxTimeMs, walkableZones) {
        const now = performance.now();
        for (const e of enemies) {
            e._trajectory = simulateEnemyTrajectory(e, maxTimeMs, walkableZones);
            e._trajMeta = {
                computeTime: now, computeX: e.x, computeY: e.y,
                fxOffsetMs: e._evadeLastTime ? (now - e._evadeLastTime) : 0,
                vx: e._vxMs || 0, vy: e._vyMs || 0
            };

            e._trajValid = true;
            if (e._trajectory && e._trajectory.length > 1) {
                const last = e._trajectory[e._trajectory.length - 1];
                let inAnyZone = false;
                for (const z of walkableZones) {
                    if (last.x >= z.x && last.x <= z.x + z.width && last.y >= z.y && last.y <= z.y + z.height) { inAnyZone = true; break; }
                }
                if (!inAnyZone && e.entityType !== 234) {
                    e._trajValid = false;
                    e._vxMs = 0; e._vyMs = 0; e._trajectory = null;
                }
            }
        }
    }

    const injectEnemies = (msg) => {
        const game = getGameRef();
        if (!game?.gameState?.entities) return;
        const gameState = game.gameState;

        if (!msg.entities) msg.entities = [];

        window.__enemyPredState = window.__enemyPredState || {};
        const enemies = [];
        for (const [id, ent] of Object.entries(gameState.entities)) {
            const numericId = Number(id);
            if (isNaN(numericId) || numericId < 0) continue;
            if (!ent.isEnemy || ent.isPlayer || ent.entityType === 130 || _ignoredTypes.has(ent.entityType)) continue;
            if ((ent.name || '').toLowerCase().includes('switch')) continue;
            if (typeof ent.x !== 'number' || typeof ent.y !== 'number' || !ent.radius) continue;

            enemies.push({ numericId, ent });
        }

        updateEnemyPrediction(enemies.map(e => e.ent));

        let bounceZones = [];
        if (game.area && game.area.zones) {
            bounceZones = game.area.zones.list().filter(z => z.type === 0);
        }

        const predMs = window.__enemySmoothPendingTicks > 0 ? window.__enemySmoothPendingTicks * SERVER_TICK_MS : (window._client.ping || 0) * 0.5 + SERVER_TICK_MS;

        precomputeTrajectories(enemies.map(e => e.ent), predMs + 50, bounceZones);

        // Clean up stale enemies from our sandbox state using the filtered array
        const activeCloneIds = new Set(enemies.map(e => String(-e.numericId - CLONE_OFFSET)));
        for (const id of Object.keys(window.__enemyPredState)) {
            if (!activeCloneIds.has(id)) delete window.__enemyPredState[id];
        }

        // Inject clones for the filtered enemies
        for (const { numericId, ent } of enemies) {
            const id = String(numericId);
            const cloneId = String(-numericId - CLONE_OFFSET);
            const state = window.__enemyPredState[cloneId];

            // Update state on server message
            window.__enemyPredState[cloneId] = {
                serverBaseTime: performance.now(),
                serverBaseX: ent.x,
                serverBaseY: ent.y,
                vxMs: ent._vxMs || 0,
                vyMs: ent._vyMs || 0,
                predMs: predMs,
                trajectory: ent._trajectory,
                trajValid: ent._trajValid,
                smoothX: state ? state.smoothX : ent._predX,
                smoothY: state ? state.smoothY : ent._predY,
                radius: ent.radius // Save radius so clone never disappears if original gets 0 radius
            };

            const clone = Object.assign({}, ent, {
                id: -numericId - CLONE_OFFSET,
                x: window.__enemyPredState[cloneId].smoothX,
                y: window.__enemyPredState[cloneId].smoothY,
                radius: ent.radius, // Force real radius so clone isn't invisible
                isDestroyed: false,
            });

            const storedProps = originalProps.get(id);
            if (storedProps && storedProps.effectsData) {
                clone.effects = ent.effects ? JSON.parse(JSON.stringify(ent.effects)) : {};
                clone.effects.effects = JSON.parse(JSON.stringify(storedProps.effectsData));
            } else if (ent.effects) {
                try {
                    clone.effects = JSON.parse(JSON.stringify(ent.effects));
                } catch (e) {
                    clone.effects = ent.effects;
                }
            }
            msg.entities.push(clone);
        }
    };

    function cacheIncomingAuras(game) {
        if (!game?.gameState?.entities) return;

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
    }

    // ========== OVERLAY RENDERING ==========
    function drawBalls(nativeCtx, game, camera, now) {
        const gameState = game.gameState;
        const player = game.player;
        const canvas = nativeCtx.canvas;

        if (!gameState || !camera || !player) return;

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

        // --- Rendering Gloop pieces ---
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

        // --- Calculating screen coordinates for player overlay render ---
        let playerCanvasX = canvas.width / 2;
        let playerCanvasY = canvas.height / 2;

        if (isPredictPlayerEnabled) {
            const pd = window.__predictData;
            if (pd && (now - pd.time) < 100) {
                const screenPos = worldToScreen(pd.x, pd.y);
                playerCanvasX = screenPos.x;
                playerCanvasY = screenPos.y;
            }
        }

        // --- Rendering player body (Overlay) ---
        if (!(isPredictPlayerEnabled && !isHideSelfEnabled)) {
            const playerRadius = (player.radius || DEFAULT_PLAYER_RADIUS) * scale;
            nativeCtx.globalAlpha = PLAYER_ALPHA;
            nativeCtx.beginPath();
            nativeCtx.arc(playerCanvasX, playerCanvasY, playerRadius, 0, Math.PI * 2);
            if (player.isEmberInvulnerable) {
                nativeCtx.fillStyle = '#000000';
            } else {
                nativeCtx.fillStyle = player.color || '#00ff88';
            }
            nativeCtx.fill();
            nativeCtx.globalAlpha = 1;

            let playerStrokeWidth = 2;
            let playerStrokeColor = '#ffffff';
            if (player.isBandaged === true) playerStrokeWidth = 5;
            if (player.isUnbandaging === true) {
                playerStrokeWidth = 5;
                playerStrokeColor = '#ff0000';
            }
            nativeCtx.beginPath();
            nativeCtx.arc(playerCanvasX, playerCanvasY, playerRadius, 0, Math.PI * 2);
            nativeCtx.strokeStyle = playerStrokeColor;
            nativeCtx.lineWidth = playerStrokeWidth;
            nativeCtx.stroke();
        }
    }

    // ========== SYNCHRONOUS VISIBILITY MODIFIERS ==========
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
            if (Number(id) < 0) continue;

            if (entity.entityType === 136) {
                if (!gloopOriginalRenders.has(id)) {
                    gloopOriginalRenders.set(id, entity.render);
                }
                entity.render = () => { };
                continue;
            }

            if (!entity.isEnemy || entity.nick !== undefined || entity.entityType === 118 || entity.entityType === 113 || _ignoredTypes.has(entity.entityType) || entity.id === selfId || entity.isPlayer) continue;
            if (entity.entityType === 130 || (entity.name || '').toLowerCase().includes('switch')) continue;

            if (!originalVisibility.has(id)) originalVisibility.set(id, entity.isDestroyed);

            if (!originalProps.has(id) && entity.effects && entity.effects.effects) {
                try {
                    originalProps.set(id, {
                        hasEffects: true,
                        effectsData: JSON.parse(JSON.stringify(entity.effects.effects))
                    });
                } catch (e) {
                    originalProps.set(id, {
                        hasEffects: true,
                        effectsData: entity.effects.effects
                    });
                }
            }

            if (entity.effects?.effects && Number(id) >= 0) { //fixed effect not clearing in ball with id 0
                for (const key in entity.effects.effects) {
                    if (entity.effects.effects[key] && entity.effects.effects[key].radius !== undefined) {
                        entity.effects.effects[key].radius = 0;
                    }
                }
            }
            entity.isDestroyed = true;
        }
    }

    function restoreOriginalBalls(game) {
        if (!game?.gameState?.entities) return;

        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (entity.entityType === 136 && gloopOriginalRenders.has(id)) {
                entity.render = gloopOriginalRenders.get(id);
            }
        }
        gloopOriginalRenders.clear();

        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (originalVisibility.has(id)) {
                entity.isDestroyed = originalVisibility.get(id);
                originalVisibility.delete(id);
            }

            if (originalProps.has(id)) {
                const stored = originalProps.get(id);
                if (stored.effectsData) {
                    if (!entity.effects) entity.effects = {};
                    if (!entity.effects.effects) entity.effects.effects = {};

                    for (const key in stored.effectsData) {
                        entity.effects.effects[key] = stored.effectsData[key];
                    }
                }
                originalProps.delete(id);
            }
        }
    }

    // ========== PLAYER CLASS COORDINATE SUBSTITUTION HOOK ==========
    function runPlayerRenderHook() {
        const game = getGameRef();
        const playerEntity = game?.player;
        if (!playerEntity) return;

        let proto = Object.getPrototypeOf(playerEntity);
        while (proto && !proto.hasOwnProperty('render')) {
            proto = Object.getPrototypeOf(proto);
        }

        if (proto && !proto._originalRender) {
            proto._originalRender = proto.render;

            proto.render = function (ctx, camera) {
                const isSelf = this.isLocalPlayer === true ||
                               (window._client?.user?.self?.id && this.id === window._client.user.self.id);

                if (isSelf && isPredictPlayerEnabled) {
                    const pd = window.__predictData;
                    const now = performance.now();

                    if (pd && (now - pd.time) < 100) {
                        const offsetX = pd.x - this.x;
                        const offsetY = pd.y - this.y;

                        const realX = this.x;
                        const realY = this.y;

                        this.x += offsetX;
                        this.y += offsetY;

                        const renderResult = this._originalRender.call(this, ctx, camera);

                        this.x = realX;
                        this.y = realY;

                        return renderResult;
                    }
                }
                return this._originalRender.call(this, ctx, camera);
            };
            console.log("%c[RenderHook] Successfully intercepted player class render prototype!", "color: #00ff00; font-weight: bold;");
        }
    }

    // ========== INJECTION INTO AREA (ENGINE RENDER LOOP) ==========
    function runRenderHook() {
        const game = getGameRef();
        if (!game || !game.area || !game.camera) return;

        runPlayerRenderHook();

        if (currentArea !== game.area) {
            const liveGame = getGameRef();

            gloopOriginalRenders.clear();
            currentArea = game.area;
            originalProps.clear();
            originalVisibility.clear();
            window.__gloopOffsets = [];
        }

        if (currentArea && !currentArea._originalRender) {
            currentArea._originalRender = currentArea.render;

            currentArea.render = function (nativeCtx, cam) {
                const liveGame = getGameRef();

                if (!isOverlayEnabled) {
                    return this._originalRender.call(this, nativeCtx, cam);
                }

                cacheIncomingAuras(liveGame);

                const now = performance.now();
                if (!window.__lastEnemyFrameTime) window.__lastEnemyFrameTime = now;
                const dtMs = Math.min(now - window.__lastEnemyFrameTime, 50);
                window.__lastEnemyFrameTime = now;

                if (liveGame?.gameState?.entities) {
                    for (const id of Object.keys(liveGame.gameState.entities)) {
                        const numId = Number(id);
                        if (numId < 0) {
                            const originalId = String(-numId - CLONE_OFFSET); // Fixed: Reversing the clone ID math with CLONE_OFFSET
                            const originalEnt = liveGame.gameState.entities[originalId];
                            const cloneEnt = liveGame.gameState.entities[id];

                            if (!originalEnt) {
                                delete liveGame.gameState.entities[id];
                                if (window.__enemyPredState) delete window.__enemyPredState[id];
                                continue;
                            }

                            const state = window.__enemyPredState ? window.__enemyPredState[id] : null;
                            if (state) {
                                const hasVelocity = Math.abs(state.vxMs) > 0.0001 || Math.abs(state.vyMs) > 0.0001;

                                if (hasVelocity) {
                                    cloneEnt.isDestroyed = false;
                                    if (cloneEnt.radius === 0 && originalEnt.radius > 0) cloneEnt.radius = originalEnt.radius;

                                    // 1. Time elapsed since the last server update for this enemy
                                    const T = now - state.serverBaseTime;

                                    // 2. The exact point in time we want to render on the trajectory
                                    const renderTimeMs = T + state.predMs;

                                    let idealX, idealY;

                                    // 3. Get the position from the trajectory
                                    if (state.trajValid && state.trajectory && state.trajectory.length > 0) {
                                        const trajPos = interpolateTrajectory(state.trajectory, renderTimeMs);
                                        if (trajPos) {
                                            idealX = trajPos.x;
                                            idealY = trajPos.y;
                                        }
                                    }

                                    // Fallback to straight line if trajectory failed
                                    if (idealX === undefined) {
                                        idealX = state.serverBaseX + state.vxMs * renderTimeMs;
                                        idealY = state.serverBaseY + state.vyMs * renderTimeMs;
                                    }

                                    // 4. Smoothly blend towards the ideal position to hide micro-jumps from server corrections
                                    const lerpFactor = 1 - Math.pow(0.2, dtMs / 16.66);
                                    state.smoothX += (idealX - state.smoothX) * lerpFactor;
                                    state.smoothY += (idealY - state.smoothY) * lerpFactor;

                                    // 5. Apply to the game engine's entity for rendering
                                    cloneEnt.x = state.smoothX;
                                    cloneEnt.y = state.smoothY;
                                } else {
                                    // If an enemy has stopped (e.g. frozen by ability) render it at its server position
                                    cloneEnt.isDestroyed = false;
                                    if (cloneEnt.radius === 0 && originalEnt.radius > 0) cloneEnt.radius = originalEnt.radius;
                                    cloneEnt.x = state.serverBaseX;
                                    cloneEnt.y = state.serverBaseY;
                                    state.smoothX = state.serverBaseX;
                                    state.smoothY = state.serverBaseY;
                                }
                            }
                        }
                    }
                }

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

    // ==================== UI BUTTONS BLOCK ====================
    function createBtn(bottom, text, color, onClick) {
        const btn = document.createElement('div');
        btn.style.cssText = `position: fixed; bottom: ${bottom}px; left: 10px; background: rgba(0,0,0,0.85); color: ${color}; font-family: monospace; font-size: 11px; padding: 6px 10px; border-radius: 6px; z-index: 1000000; cursor: pointer; border: 1px solid ${color}; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none;`;
        btn.innerText = text;
        btn.onclick = onClick;
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        document.body.appendChild(btn);
        return btn;
    }

    const overlayBtn = createBtn(60, '🎨 Scripts [ON]', '#0f0', () => {
        isOverlayEnabled = !isOverlayEnabled;
        window.toggleCam()
        if (!isOverlayEnabled) {
            const game = getGameRef();
            if (game) {
                restoreOriginalBalls(game);
                if (originalSelfProps && game.gameState?.entities?.[game.gameState.selfId]) {
                    game.gameState.entities[game.gameState.selfId].isDeparted = originalSelfProps.isDeparted;
                    originalSelfProps = null;
                }
                if (game.gameState?.entities) {
                    for (const id of Object.keys(game.gameState.entities)) {
                        if (Number(id) < 0) delete game.gameState.entities[id];
                    }
                }
            }
            originalVisibility.clear();
            originalProps.clear();
        }

        overlayBtn.innerText = `🎨 OVERLAY [${isOverlayEnabled ? 'ON' : 'OFF'}]`;
        overlayBtn.style.borderColor = isOverlayEnabled ? '#0f0' : '#f00';

        hideBtn.innerText = `👻 HIDE ORIGINALS [${isHideOriginalEnabled ? 'ON' : 'OFF'}]`;
        hideBtn.style.borderColor = isHideOriginalEnabled ? '#f0f' : '#0ff';
        selfBtn.innerText = `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`;
        selfBtn.style.borderColor = isHideSelfEnabled ? '#f0f' : '#ffa';
        predictPlayerBtn.innerText = `🚀 PREDICT PLAYER [${isPredictPlayerEnabled ? 'ON' : 'OFF'}]`;
        predictPlayerBtn.style.borderColor = isPredictPlayerEnabled ? '#0f0' : '#f00';
    });

    const hideBtn = createBtn(110, '👻 HIDE ORIGINALS [ON]', '#f0f', () => {
        isHideOriginalEnabled = !isHideOriginalEnabled;
        hideBtn.innerText = `👻 HIDE ORIGINALS [${isHideOriginalEnabled ? 'ON' : 'OFF'}]`;
        hideBtn.style.borderColor = isHideOriginalEnabled ? '#f0f' : '#0ff';
    });

    const selfBtn = createBtn(160, '👤 HIDE SELF [OFF]', '#ffa', () => {
        isHideSelfEnabled = !isHideSelfEnabled;
        selfBtn.innerText = `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`;
        selfBtn.style.borderColor = isHideSelfEnabled ? '#f0f' : '#ffa';
    });

    const predictPlayerBtn = createBtn(210, '🚀 PREDICT PLAYER [ON]', '#0f0', () => {
        isPredictPlayerEnabled = !isPredictPlayerEnabled;
        predictPlayerBtn.innerText = `🚀 PREDICT PLAYER [${isPredictPlayerEnabled ? 'ON' : 'OFF'}]`;
        predictPlayerBtn.style.borderColor = isPredictPlayerEnabled ? '#0f0' : '#f00';
    });

    const extraTickBtn = createBtn(260, '🔒 Unlock FPS [OFF]', '#ffa500', () => {
        window._client.unlockFPS = !window._client.unlockFPS;
        extraTickBtn.innerText = window._client.unlockFPS ? '🔓 Unlock FPS [ON]' : '🔒 Unlock FPS [OFF]';
        extraTickBtn.style.borderColor = window._client.unlockFPS ? '#0f0' : '#ffa500';
    });
    // Entity cache cleanup
    setInterval(() => {
        const game = getGameRef();
        if (game?.gameState?.entities) {
            const existingIds = new Set(Object.keys(game.gameState.entities));
            for (const [id] of originalProps) {
                if (!existingIds.has(id)) originalProps.delete(id);
            }
            for (const [id] of originalVisibility) {
                if (!existingIds.has(id)) originalVisibility.delete(id);
            }
        }
    }, 4000);

    window.addEventListener('keydown', (e) => {
        if (e.key === 'PageUp') {
            e.preventDefault();
            isUIVisible = !isUIVisible;
            [overlayBtn, hideBtn, selfBtn, predictPlayerBtn, extraTickBtn].forEach(b => b.style.display = isUIVisible ? 'block' : 'none');
        }
    });

    setInterval(runRenderHook, 32);
})();