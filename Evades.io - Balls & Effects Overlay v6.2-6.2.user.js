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
    const GHOST_ALPHA = 0.13;
    const HARMLESS_ALPHA = 0.13;
    const GRASSHARMLESS_ALPHA = 0.13;
    const DEFAULT_PLAYER_RADIUS = 15;
    const PLAYER_ALPHA = 0.7;

    // ==================== НАСТРОЙКИ ЭКСТРАПОЛЯЦИИ ====================
    const SERVER_TICK_MS = 1000 / 60;

    // ==================== КОНФИГУРАЦИЯ ТИПОВ ШАРОВ ====================
    const ALLOWED_PROJECTILES = new Set([18, 33, 79, 83, 108, 145, 147, 186, 215]);
    const _ignoredTypes = new Set([62, 72, 199, 8]);
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

    // ==================== Main Input / Output Hook ====================
    window._client = window._client || {};
    Object.assign(window._client, {
        seqQueue: [],
        selfCmdHistory: [],
        selfAcked: null,
        ping: 0,
        pingHistory: [],
    });


    let _obs = new MutationObserver((ev) => {
        let elem = Array.from(document.querySelectorAll('script')).filter(a => a.type === "module" && a.src.match(/\/index\.[0-9a-f]{8}\.js/))[0];
        if (!elem) return;
        let src = elem.src

        if (!navigator.userAgent.includes("Firefox")) elem.remove()

        let req = new XMLHttpRequest()
        req.open("GET", src, false)
        req.send()
        let code = req.response
        code = code
            .replace(/processServerMessage\(([^)]+)\)\{/, (m, msgVar) => `processServerMessage(${msgVar}){
        try {
            window._client && window._client.onMessage && window._client.onMessage(${msgVar});
        } catch(e){}`)

            .replace(/ag\.emit\(([^)]+)\)/, (m, msgVar) => `(window._client && window._client.input && window._client.input(${msgVar}), ag.emit(${msgVar}))`)

        let nScr = document.createElement("script")
        nScr.setAttribute("type", "module")
        nScr.innerHTML = code
        setTimeout(() => {
            document.body.appendChild(nScr)
        }, 100) // Delay to ensure the original script is removed before adding the modified one
        console.log("Init")
        _obs.disconnect()

    })
    _obs.observe(document, { childList: true, subtree: true });

    // ==================== MSG EVENT LOGIC FUNCTIONS ====================
    window._client.input = (msg) => {
        //console.log("Input", msg);

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

    let lastSeq = -1;
    let lastPong = -1;
    let lastPongTime = Date.now();

    window._client.onMessage = (msg) => {
        if (!msg.entities) msg.entities = [];

        /*if (lastSeq != msg.sequence) {
            console.log("Output", msg)
            lastSeq = msg.sequence
        }*/
        let me = msg?.globalEntities?.find(e => e.id === window._client.user?.self?.id);

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

        if (window._client.selfCmdHistory) {
            window._client.selfCmdHistory = window._client.selfCmdHistory.filter(
                cmd => cmd.seq > msg.sequence
            );
        }
        let _seq = window._client.seqQueue.find(q => q[0] === msg.sequence);
        if (_seq) {
            const rawPing = +new Date() - _seq[1];

            // Keep a sliding window of the last 8 pings for a very stable average
            window._client.pingHistory.push(rawPing);
            if (window._client.pingHistory.length > 8) {
                window._client.pingHistory.shift();
            }

            const sum = window._client.pingHistory.reduce((a, b) => a + b, 0);
            window._client.ping = Math.round(sum / window._client.pingHistory.length * 100) / 100;

            window._client.seqQueue = window._client.seqQueue.filter(q => q[0] > msg.sequence);
        }

        if (msg.pong) return; // Skip ping messages
        if (!isOverlayEnabled) return
        // --- Clean up injected predicted enemies when area changes ---
        if (msg.area) {
            const game = getGameRef();
            if (game?.gameState?.entities) {
                for (const id of Object.keys(game.gameState.entities)) {
                    // If the ID is a negative number (as a string), it's one of our clones
                    if (Number(id) < 0) {
                        delete game.gameState.entities[id];
                    }
                }
            }
        }

        injectEnemies(msg);
    };


    // ==================== УПРАВЛЕНИЕ ХУКАМИ ====================
    let isOverlayEnabled = true;
    let isHideOriginalEnabled = false;
    let isHideSelfEnabled = false;
    let isUIVisible = true;
    let isExtrapolationEnabled = true;

    let currentArea = null;
    let originalProps = new Map();

    let originalVisibility = new Map();
    let originalEffectVisibility = new Map();

    let originalSelfProps = null;
    let ballVelocities = new Map();
    let ballAuras = new Map();
    let gloopOriginalRenders = new Map();   // сохранение оригинальных render для Gloop


    // ==================== CONFIG & GLOBALS FOR PREDICTION ====================
    const config = {
        bounceDetectAngle: Math.PI / 3,
        enemyEmaAlpha: 0.15,
        enemyStoppedMs: 300,
        bounceSimStepMs: 12,
    };

    const ENEMY_TYPE_WALL = 229;
    const _walkableTypeSet = new Set([0, 4, 6]);

    let _plLastPos = null, _plLastTime = 0, _plVxMs = 0, _plVyMs = 0;

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
        } catch (e) { }
        return null;
    }

    function updateEnemyPrediction(enemies) {
        const now = performance.now();
        const tickDelay = window._client.seqQueue ? window._client.seqQueue.length : 0;
        const predMs = window._client.ping;

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
            // Moving horizontally: snap Y to horizontal wall (perpendicular to movement)
            if (onTop) y = bTop;
            if (onBottom) y = bBottom;
        } else {
            // Moving vertically: snap X to vertical wall (perpendicular to movement)
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
        const now = performance.now();

        const enemies = [];
        for (const [id, ent] of Object.entries(gameState.entities)) {
            if (Number(id) < 0) continue; // Don't process injected clones
            if (!ent.isEnemy) continue;
            if (ent.nick !== undefined || ent.entityType === 118 || ent.entityType === 113 || ent.entityType === 130 || _ignoredTypes.has(ent.entityType)) continue;
            if ((ent.name || '').toLowerCase().includes('switch')) continue;
            if (ent.entityType === 136) continue; // Fixed typo from `entity` to `ent`
            if (typeof ent.x !== 'number' || typeof ent.y !== 'number' || !ent.radius) continue;

            enemies.push(ent);
        }
        // 1. Update velocities and linear predictions
        updateEnemyPrediction(enemies);

        // 2. Get zones for bouncing simulation
        let bounceZones = [];
        try {
            if (game.area && game.area.zones) {
                bounceZones = typeof game.area.zones.list === 'function'
                    ? game.area.zones.list()
                    : (Array.isArray(game.area.zones) ? game.area.zones : []);
            }
        } catch (e) { }

        // 3. Calculate prediction time
        const SERVER_TICK_MS = 1000 / 60;
        const tickDelay = window._client.seqQueue ? window._client.seqQueue.length : 0;
        const predMs = window._client.ping;

        // 4. Precompute trajectories with bouncing
        precomputeTrajectories(enemies, predMs, bounceZones);

        // 5. Inject clones (only if moving and extrapolation is on)
        for (const [id, ent] of Object.entries(gameState.entities)) {
            const numericId = Number(id);
            if (isNaN(numericId) || numericId < 0) continue; // Skip clones here

            const hasVelocity = Math.abs(ent._vxMs) > 0.0001 || Math.abs(ent._vyMs) > 0.0001;

            if (isExtrapolationEnabled && hasVelocity) {
                let predX, predY;

                // Use trajectory if valid, otherwise fallback to linear prediction
                if (ent._trajValid && ent._trajectory) {
                    const trajPos = interpolateTrajectory(ent._trajectory, predMs);
                    if (trajPos) {
                        predX = trajPos.x;
                        predY = trajPos.y;
                    } else {
                        predX = ent._predX;
                        predY = ent._predY;
                    }
                } else {
                    predX = ent._predX;
                    predY = ent._predY;
                }

                const clone = Object.assign({}, ent, {
                    id: -numericId,
                    x: predX,
                    y: predY,
                    isDestroyed: false,
                });

                // Use stored effects if available (before radius was set to 0), otherwise copy current
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
        }
    };

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
                //window._client.ping = avgPing
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
            if (id < 0) continue; // Skip our injected clones safely!

            if (!entity.isEnemy || entity.nick !== undefined || entity.entityType === 118 || entity.entityType === 113 || _ignoredTypes.has(entity.entityType) || entity.id === selfId || entity.isPlayer) continue;
            if (entity.entityType === 130 || (entity.name || '').toLowerCase().includes('switch')) continue;

            // Скрытие Gloop: ломаем render
            if (entity.entityType === 136) {
                if (!gloopOriginalRenders.has(id)) {
                    gloopOriginalRenders.set(id, entity.render);
                }
                entity.render = () => { };
                continue;
            }
            if (!originalVisibility.has(id)) originalVisibility.set(id, entity.isDestroyed);

            // Store the inner effects array BEFORE modifying them so clones can use original values
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

            // Zero out all effect radii to hide them properly
            if (entity.effects?.effects && Number(id) > 0) {
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

        // Восстанавливаем render для Gloop
        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (entity.entityType === 136 && gloopOriginalRenders.has(id)) {
                entity.render = gloopOriginalRenders.get(id);
            }
        }
        gloopOriginalRenders.clear();

        // Обычные враги
        for (const [id, entity] of Object.entries(game.gameState.entities)) {
            if (originalVisibility.has(id)) {
                entity.isDestroyed = originalVisibility.get(id);
                console.log(`Restored isDestroyed for entity ${id} to ${entity.isDestroyed}`);
                originalVisibility.delete(id);
            }

            // Restore effects data without replacing the entity.effects class instance
            if (originalProps.has(id)) {
                const stored = originalProps.get(id);
                if (stored.effectsData) {
                    if (!entity.effects) entity.effects = {};
                    if (!entity.effects.effects) entity.effects.effects = {};

                    for (const key in stored.effectsData) {
                        // Put the saved effect data back into the game's array
                        entity.effects.effects[key] = stored.effectsData[key];
                    }
                }
                originalProps.delete(id);
            }
        }
    }

    // ========== 6. ИНЪЕКЦИЯ В AREA ==========
    function runRenderHook() {
        const game = getGameRef();
        if (!game || !game.area || !game.camera) return;

        if (currentArea !== game.area) {
            const liveGame = getGameRef();

            // Восстанавливаем все сломанные render перед сменой зоны
            for (const [id, origRender] of gloopOriginalRenders.entries()) {
                if (liveGame?.gameState?.entities?.[id]) {
                    liveGame.gameState.entities[id].render = origRender;
                }
            }
            gloopOriginalRenders.clear();

            // Delete all clones on area change
            if (liveGame?.gameState?.entities) {
                for (const id of Object.keys(liveGame.gameState.entities)) {
                    if (Number(id) < 0) {
                        delete liveGame.gameState.entities[id];
                    }
                }
            }

            currentArea = game.area;
            ballVelocities.clear();
            ballAuras.clear();
            originalProps.clear();
            window.__gloopOffsets = [];
        }

        if (currentArea && !currentArea._originalRender) {
            currentArea._originalRender = currentArea.render;

            currentArea.render = function (nativeCtx, cam) {
                const liveGame = getGameRef();

                // MASTER SWITCH: Skip all modifications if script is OFF
                if (!isOverlayEnabled) {
                    return this._originalRender.call(this, nativeCtx, cam);
                }

                cacheIncomingAuras(liveGame);
                // Manage clone visibility and clean up stale clones every frame
                if (liveGame?.gameState?.entities) {
                    for (const id of Object.keys(liveGame.gameState.entities)) {
                        const numId = Number(id);
                        if (numId < 0) {
                            const originalId = String(-numId);
                            const originalEnt = liveGame.gameState.entities[originalId];
                            const cloneEnt = liveGame.gameState.entities[id];

                            if (!originalEnt) {
                                // Original enemy is gone, delete the clone completely
                                delete liveGame.gameState.entities[id];
                                continue;
                            }

                            const hasVelocity = Math.abs(originalEnt._vxMs) > 0.0001 || Math.abs(originalEnt._vyMs) > 0.0001;

                            if (isExtrapolationEnabled && hasVelocity) {
                                // Force visible
                                cloneEnt.isDestroyed = false;
                                cloneEnt.currentTransparency = 1;
                                if (cloneEnt.radius === 0 && originalEnt.radius > 0) cloneEnt.radius = originalEnt.radius;
                            } else {
                                // Force hidden instead of deleting to prevent spawn flicker
                                cloneEnt.isDestroyed = true;
                                cloneEnt.currentTransparency = 0;
                                cloneEnt.radius = 0;
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

        if (!isOverlayEnabled) {
            // Turning OFF: Force disable sub-features and clean up
            isExtrapolationEnabled = false;
            isHideOriginalEnabled = false;
            isHideSelfEnabled = false;

            const game = getGameRef();
            if (game) {
                restoreOriginalBalls(game);
                if (originalSelfProps && game.gameState?.entities?.[game.gameState.selfId]) {
                    game.gameState.entities[game.gameState.selfId].isDeparted = originalSelfProps.isDeparted;
                    originalSelfProps = null;
                }
                if (game.gameState?.entities) {
                    for (const id of Object.keys(game.gameState.entities)) {
                        if (Number(id) < 0) {
                            delete game.gameState.entities[id];
                        }
                    }
                }
            }
            originalVisibility.clear();
            originalProps.clear();
        } else {
            // Turning ON: Restore default active states
            isExtrapolationEnabled = true;
        }

        overlayBtn.innerHTML = `🎨 OVERLAY [${isOverlayEnabled ? 'ON' : 'OFF'}]`;
        overlayBtn.style.borderColor = isOverlayEnabled ? '#0f0' : '#f00';

        // Update sub-feature buttons to reflect forced states
        hideBtn.innerHTML = `👻 HIDE ORIGINALS [${isHideOriginalEnabled ? 'ON' : 'OFF'}]`;
        hideBtn.style.borderColor = isHideOriginalEnabled ? '#f0f' : '#0ff';
        selfBtn.innerHTML = `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`;
        selfBtn.style.borderColor = isHideSelfEnabled ? '#f0f' : '#ffa';
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
            [overlayBtn, hideBtn, selfBtn, extrapolateBtn].forEach(b => b.style.display = isUIVisible ? 'block' : 'none');
        }
    });

    setInterval(runRenderHook, 32);
})();