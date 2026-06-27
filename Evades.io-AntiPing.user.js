// ==UserScript==
// @name         Evades.io - Anti Ping Main
// @namespace    https://evades.io/
// @version      8.1.0
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

    // ==================== SETTINGS PERSISTENCE ====================
    const loadSetting = (key, defaultVal) => {
        const val = localStorage.getItem(key);
        return val === null ? defaultVal : val === 'true';
    };
    const saveSetting = (key, val) => localStorage.setItem(key, String(val));

    // ==================== CONFIG & GLOBALS ====================
    const DEFAULT_PLAYER_RADIUS = 15;
    const PLAYER_ALPHA = 0.7;
    const SERVER_TICK_MS = 1000 / 60;
    const _ignoredTypes = new Set([62, 72, 199, 8, 113, 228, 136]);

    let isOverlayEnabled = loadSetting('antiping_scripts', true);
    let isHideSelfEnabled = loadSetting('antiping_hideself', false);
    let isPredictPlayerEnabled = loadSetting('antiping_predictp', true);
    let isUIVisible = true;

    let currentArea = null;
    let originalSelfProps = null;
    let __savedPositions = new Map();

    window._client = window._client || {};
    Object.assign(window._client, {
        seqQueue: [],
        selfCmdHistory: [],
        selfAcked: null,
        ping: 0,
        pingHistory: [],
        unlockFPS: loadSetting('antiping_unlockfps', false)
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
            .replace("this.renderer.render(this.gameState)", a => "(window._client.preRender&&window._client.preRender(this.gameState),this.renderer.render(this.gameState),window._client.postRender&&window._client.postRender(this.gameState))")
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

    // ==================== Main Input / Output Hook ====================
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
        if (msg.pong) return; // Skip ping messages
        if (!isOverlayEnabled) return;

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

        if (msg.area) {
            window._client.selfCmdHistory = []; // Clear command history on area change
            window.__enemyPredState = {}; // Clear enemy prediction state on area change
        }

        // Parse xyEntities into a map for fresh server positions
        const serverUpdates = new Map();
        if (msg.xyEntities) {
            const buffer = msg.xyEntities;
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const count = Math.floor(buffer.length / 12);
            for (let i = 0; i < count; i++) {
                const offset = i * 12;
                const id = view.getUint32(offset, true);
                const x = view.getFloat32(offset + 4, true);
                const y = view.getFloat32(offset + 8, true);
                serverUpdates.set(id, { x, y });
            }
        }

        processEnemyPredictions(serverUpdates);
    };

    const config = {
        bounceDetectAngle: Math.PI / 3,
        enemyEmaAlpha: 0.15,
        enemyStoppedMs: 300,
        bounceSimStepMs: 12,
    };

    const ENEMY_TYPE_WALL = 229;

    // ==================== EXTENSIBLE BALL BEHAVIOR PREDICTORS ====================
    /**
     * Custom prediction behavior for Icicle (Type 71).
     * Handles variable frame rates (unlock_fps) safely via dynamic deltaTime.
     * @param {Object} ent - The entity object being predicted
     * @param {number} deltaTime - Time step in milliseconds
     */
    function predictIcicleBehavior(ent, deltaTime) {
        if (ent.clock === undefined) ent.clock = 0;
        if (ent.wallHit === undefined) ent.wallHit = false;

        if (ent.wallHit) {
            ent.clock += deltaTime;
            if (ent.clock > 1000) {
                ent.wallHit = false;
                ent.clock = 0;
                ent.speedMultiplier = 1;
            } else {
                ent.speedMultiplier = 0;
            }
        } else {
            if (ent.speedMultiplier === undefined || ent.speedMultiplier === 0) {
                ent.speedMultiplier = 1;
            }
        }
    }
    // Registry mapping entityTypes to their specific client-side routines
    const ENTITY_PREDICTORS = {
        71: predictIcicleBehavior,
    };
    /**
     * Core dispatcher for frame-by-frame entity behavior ticking.
     * @param {Object} ent - The entity clone being processed
     * @param {number} deltaTime - The calculated frame step time slice
     */
    function predictEntityBehavior(ent, deltaTime) {
        if (!ent) return;
        const entType = ent.entityType ?? ent.type ?? 0;
        const handler = ENTITY_PREDICTORS[entType];
        if (handler) {
            handler(ent, deltaTime);
        } else {
            if (ent.speedMultiplier === undefined) {
                ent.speedMultiplier = 1;
            }
        }
    }
    /**
 * Custom long-term trajectory simulation for Dripping balls (Type 30).
 */
    function simulateDrippingTrajectory(e, maxTimeMs, bounceZones) {
        const stepMs = config.bounceSimStepMs || 12;
        const ping = window._client.ping || 0; // Get the current client ping
        let x = e.x;
        let y = e.y;
        let currentRadius = e.radius || 0;

        let vx = e._vxMs || 0;
        let vy = e._vyMs || 0;
        let rVel = e._radiusVel || 0.0075;
        let maxR = e._maxObservedRadius || 0;
        let minR = e._minObservedRadius || 0;

        // Initialize global cache for dripper speeds across ticks if it doesn't exist
        if (!window._dripperSpeedCache) {
            window._dripperSpeedCache = new Map();
        }

        // Capture and save the real speed when it's active (e.g., first frames when radius < 1)
        if (e._speedMs && e._speedMs > 0) {
            if (e.id !== undefined) {
                window._dripperSpeedCache.set(e.id, e._speedMs);
            }
            e._cachedDripperSpeedMs = e._speedMs;
        }

        // Retrieve the stored speed from global map or local entity cache
        const cachedSpeed = (e.id !== undefined ? window._dripperSpeedCache.get(e.id) : null) || e._cachedDripperSpeedMs;

        // Fallback chain to ensure we always have a valid speed value
        const speedMs = cachedSpeed ||
            e._speedMs ||
            config.dripperDefaultSpeedMs ||
            1;

        // Adjust remaining inflation time by subtracting ping, and scale speed accordingly
        if (maxR > 0 && currentRadius < maxR && rVel > 0) {
            const normalInflationTime = (maxR - currentRadius) / rVel;
            const adjustedInflationTime = normalInflationTime - ping + 32;

            // Handle cases where the adjusted time goes out of bounds (<= 0)
            if (adjustedInflationTime <= 0) {
                currentRadius = maxR;
                rVel = 0; // Fully inflated immediately due to latency
            } else {
                rVel = (maxR - currentRadius) / adjustedInflationTime;
            }
        }

        let isFrozen = false;

        let zone = null;
        if (bounceZones && bounceZones.length > 0) {
            const zonePadding = 32;
            for (const z of bounceZones) {
                if (x >= z.x - zonePadding && x <= z.x + z.width + zonePadding &&
                    y >= z.y - zonePadding && y <= z.y + z.height + zonePadding) {
                    zone = z;
                    break;
                }
            }
        }

        const points = [{ t: 0, x, y, radius: currentRadius }];

        for (let t = stepMs; t <= maxTimeMs; t += stepMs) {
            let previousRadius = currentRadius; // Save the radius before the simulation step
            currentRadius += rVel * stepMs;

            // ICICLE APPROACH: Catch the exact tick where inflation finishes
            if (maxR > 0 && previousRadius < maxR && currentRadius >= maxR) {
                currentRadius = maxR;

                // Activate base falling speed if the ball was standing still
                if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) {
                    vy = speedMs;
                    vx = 0;
                }

                // Calculate the excess time (overTime) remaining for movement
                const overTime = rVel > 0 ? (previousRadius + rVel * stepMs - maxR) / rVel : 0;

                // Instantly apply movement for the remaining time in this tick
                x += vx * overTime;
                y += vy * overTime;

                points.push({ t, x, y, radius: currentRadius });
                continue; // Skip the standard movement block for this tick
            }

            if (maxR > 0 && currentRadius > maxR) {
                currentRadius = maxR;
            }

            // If the ball is still inflating, it is guaranteed to stand still
            if (maxR > 0 && currentRadius < maxR) {
                points.push({ t, x, y, radius: currentRadius });
                continue;
            }

            if (!isFrozen && maxR > 0 && currentRadius >= maxR) {
                if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) {
                    vy = speedMs;
                    vx = 0;
                }
            }

            if (isFrozen) {
                if (zone) {
                    const bLeft = zone.x + currentRadius, bRight = zone.x + zone.width - currentRadius;
                    const bTop = zone.y + currentRadius, bBottom = zone.y + zone.height - currentRadius;
                    x = Math.max(bLeft, Math.min(bRight, x));
                    y = Math.max(bTop, Math.min(bBottom, y));
                }
                points.push({ t, x, y, radius: currentRadius });
                continue;
            }

            if (Math.abs(vx) < 1e-7 && Math.abs(vy) < 1e-7) {
                points.push({ t, x, y, radius: currentRadius });
                continue;
            }

            let remaining = stepMs, iter = 0;
            while (remaining > 0.001 && iter++ < 6) {
                if (!zone) {
                    x += vx * remaining;
                    y += vy * remaining;
                    remaining = 0;
                    break;
                }

                const bLeft = zone.x + currentRadius, bRight = zone.x + zone.width - currentRadius;
                const bTop = zone.y + currentRadius, bBottom = zone.y + zone.height - currentRadius;

                if ((x <= bLeft && vx < 0) || (x >= bRight && vx > 0) ||
                    (y <= bTop && vy < 0) || (y >= bBottom && vy > 0)) {
                    vx = 0;
                    vy = 0;
                    x = Math.max(bLeft, Math.min(bRight, x));
                    y = Math.max(bTop, Math.min(bBottom, y));
                    isFrozen = true;
                    remaining = 0;
                    break;
                }

                let tBounce = remaining;
                let hitWall = false;

                if (vx < 0) { const tw = (bLeft - x) / vx; if (tw >= 0 && tw <= tBounce) { tBounce = tw; hitWall = true; } }
                else if (vx > 0) { const tw = (bRight - x) / vx; if (tw >= 0 && tw <= tBounce) { tBounce = tw; hitWall = true; } }

                if (vy < 0) { const tw = (bTop - y) / vy; if (tw >= 0 && tw <= tBounce) { tBounce = tw; hitWall = true; } }
                else if (vy > 0) { const tw = (bBottom - y) / vy; if (tw >= 0 && tw <= tBounce) { tBounce = tw; hitWall = true; } }

                x += vx * tBounce;
                y += vy * tBounce;
                remaining -= tBounce;

                if (hitWall) {
                    vx = 0;
                    vy = 0;
                    x = Math.max(bLeft, Math.min(bRight, x));
                    y = Math.max(bTop, Math.min(bBottom, y));
                    isFrozen = true;
                    remaining = 0;
                    break;
                }
            }
            points.push({ t, x, y, radius: currentRadius });
        }
        return points;
    }

    function simulateIcicleTrajectory(e, maxTimeMs, bounceZones) {
        const ping = window._client.ping || 0;
        const limitMs = 1032 - (ping * 0.5);
        const stepMs = config.bounceSimStepMs || 12;

        let x = e.x;
        let y = e.y;
        let simClock = e._clock || 0;
        let simWallHit = e._wallHit || false;

        let baseVx = e._vxMs || 0;
        let baseVy = e._vyMs || 0;
        if (Math.hypot(baseVx, baseVy) < 1e-6) {
            baseVx = e._lastVxMs || 0;
            baseVy = e._lastVyMs || 0;
        }

        if (simWallHit && (simClock - limitMs) > (ping * 0.5)) {
            simWallHit = false;
            baseVx = -baseVx;
            baseVy = -baseVy;
        }

        let vx = simWallHit ? 0 : baseVx;
        let vy = simWallHit ? 0 : baseVy;

        let zone = null;
        if (bounceZones && bounceZones.length > 0) {
            const zonePadding = 32;
            for (const z of bounceZones) {
                if (x >= z.x - zonePadding && x <= z.x + z.width + zonePadding &&
                    y >= z.y - zonePadding && y <= z.y + z.height + zonePadding) {
                    zone = z;
                    break;
                }
            }
        }

        const points = [{ t: 0, x, y }];

        for (let t = stepMs; t <= maxTimeMs; t += stepMs) {
            if (simWallHit) {
                simClock += stepMs;
                if (simClock >= limitMs) {
                    simWallHit = false;
                    baseVx = -baseVx;
                    baseVy = -baseVy;
                    vx = baseVx;
                    vy = baseVy;

                    const overTime = simClock - limitMs;
                    x += vx * overTime;
                    y += vy * overTime;
                }
            } else {
                x += vx * stepMs;
                y += vy * stepMs;

                if (zone) {
                    const eR = e.radius || 15;
                    const bLeft = zone.x + eR;
                    const bRight = zone.x + zone.width - eR;
                    const bTop = zone.y + eR;
                    const bBottom = zone.y + zone.height - eR;

                    if (x <= bLeft || x >= bRight || y <= bTop || y >= bBottom) {
                        x = Math.max(bLeft, Math.min(bRight, x));
                        y = Math.max(bTop, Math.min(bBottom, y));

                        simWallHit = true;
                        simClock = 0;
                        vx = 0;
                        vy = 0;
                    }
                }
            }
            points.push({ t, x, y });
        }
        return points;
    }

    // ==================== ENGINE UTILITIES ====================
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
                e._maxSpeedMs = 0;
                e._speedMs = 0;
                e._fx = e.x;
                e._fy = e.y;
                e._predX = e.x;
                e._predY = e.y;
                if (e.entityType === 71) {
                    e._clock = 0;
                    e._wallHit = false;
                    e._lastVxMs = 0;
                    e._lastVyMs = 0;
                }
                if (e.entityType === 30) {
                    e._lastRadius = e.radius;
                    e._radiusVel = 0.0075;
                    e._maxObservedRadius = 0;
                    e._minObservedRadius = 0;
                }
                continue;
            }

            const moved = (e.x !== e._evadeLastPos.x || e.y !== e._evadeLastPos.y);
            if (moved) {
                const wallClockDt = now - e._evadeLastTime;

                // Determine if the ball moved for the first time after stopping at a wall or a long idle period
                const isReboundingFromStop = (wallClockDt > SERVER_TICK_MS * 1.5) || (e._vxMs === 0 && e._vyMs === 0);

                // If the ball just left stasis, calculate the step as if it took 1 tick instead of the entire idle duration
                const numTicks = isReboundingFromStop ? 1 : Math.max(1, Math.round(wallClockDt / SERVER_TICK_MS));
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
                        // Store the ball's maximum speed during normal movement
                        if (rawSpeed > 0.001) {
                            e._maxSpeedMs = Math.max(e._maxSpeedMs || 0, rawSpeed);
                        }

                        const emaSpeed = Math.hypot(e._vxMs, e._vyMs);
                        let isBounce = false;

                        if (rawSpeed > 0.001 && emaSpeed > 0.001) {
                            const dot = (rawVxMs * e._vxMs + rawVyMs * e._vyMs) / (rawSpeed * emaSpeed);
                            const angleDiff = Math.acos(Math.max(-1, Math.min(1, dot)));
                            isBounce = angleDiff > config.bounceDetectAngle;
                        }

                        if (isReboundingFromStop) {
                            // When exiting a stop, instantly apply full speed in the movement direction, bypassing EMA lag
                            if (e._maxSpeedMs > 0) {
                                const h = Math.hypot(e.x - e._evadeLastPos.x, e.y - e._evadeLastPos.y);
                                if (h > 0.001) {
                                    e._vxMs = ((e.x - e._evadeLastPos.x) / h) * e._maxSpeedMs;
                                    e._vyMs = ((e.y - e._evadeLastPos.y) / h) * e._maxSpeedMs;
                                } else {
                                    e._vxMs = rawVxMs;
                                    e._vyMs = rawVyMs;
                                }
                            } else {
                                // If max speed is unknown (newly spawned ball), take raw speed without EMA
                                e._vxMs = rawVxMs;
                                e._vyMs = rawVyMs;
                            }
                            e._trajectory = null;
                        } else if (isBounce) {
                            e._vxMs = rawVxMs;
                            e._vyMs = rawVyMs;
                            e._trajectory = null;
                        } else {
                            // Standard EMA smoothing for continuous movement
                            e._vxMs = e._vxMs * (1 - config.enemyEmaAlpha) + rawVxMs * config.enemyEmaAlpha;
                            e._vyMs = e._vyMs * (1 - config.enemyEmaAlpha) + rawVyMs * config.enemyEmaAlpha;
                        }
                    }

                    if (e.entityType === 30) {
                        if (e._lastRadius === undefined) e._lastRadius = e.radius;
                        const deltaR = e.radius - e._lastRadius;

                        if (deltaR < -3 || deltaR > 3) {
                            e._minObservedRadius = e.radius;
                            e._maxObservedRadius = e.radius * 4;
                            e._vxMs = 0;
                            e._vyMs = 0;
                        } else if (deltaR > 0) {
                            const currentRVel = deltaR / effectiveDt;
                            if (currentRVel < 0.05) {
                                e._radiusVel = e._radiusVel * 0.85 + currentRVel * 0.15;
                            }
                            e._vxMs = 0;
                            e._vyMs = 0;
                        }
                        e._lastRadius = e.radius;
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

            if (e.entityType === 71) {
                if (e._clock === undefined) e._clock = 0;
                if (e._wallHit === undefined) e._wallHit = false;

                if (moved) {
                    e._wallHit = false;
                    e._clock = 0;
                    if (Math.hypot(e._vxMs, e._vyMs) > 1e-4) {
                        e._lastVxMs = e._vxMs;
                        e._lastVyMs = e._vyMs;
                    }
                } else {
                    if (!e._wallHit) {
                        if (Math.hypot(e._vxMs, e._vyMs) > 1e-4) {
                            e._lastVxMs = e._vxMs;
                            e._lastVyMs = e._vyMs;
                        }
                        e._wallHit = true;
                        e._clock = 0;
                    }
                }
            }
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
        if (e.entityType === 71) return simulateIcicleTrajectory(e, maxTimeMs, bounceZones);
        if (e.entityType === 30) return simulateDrippingTrajectory(e, maxTimeMs, bounceZones);

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
        if (timeMs <= 0) return { x: traj[0].x, y: traj[0].y, radius: traj[0].radius };
        const last = traj[traj.length - 1];
        if (timeMs >= last.t) return { x: last.x, y: last.y, radius: last.radius };

        let lo = 0, hi = traj.length - 1;
        while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (traj[mid].t <= timeMs) lo = mid; else hi = mid; }

        const a = traj[lo], b = traj[hi];
        const dt = b.t - a.t;
        if (dt < 1e-6) return { x: a.x, y: a.y, radius: a.radius };
        const u = (timeMs - a.t) / dt;

        const res = {
            x: a.x + (b.x - a.x) * u,
            y: a.y + (b.y - a.y) * u
        };
        if (a.radius !== undefined && b.radius !== undefined) {
            res.radius = a.radius + (b.radius - a.radius) * u;
        }
        return res;
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

    const processEnemyPredictions = (serverUpdates = new Map()) => {
        const game = getGameRef();
        if (!game?.gameState?.entities) return;
        const gameState = game.gameState;

        window.__enemyPredState = window.__enemyPredState || {};
        const enemies = [];
        for (const [id, ent] of Object.entries(gameState.entities)) {
            const numericId = Number(id);
            if (!ent.isEnemy || ent.isPlayer || ent.entityType === 130 || _ignoredTypes.has(ent.entityType)) continue;
            if ((ent.name || '').toLowerCase().includes('switch')) continue;
            if (typeof ent.x !== 'number' || typeof ent.y !== 'number' || !ent.radius) continue;

            // Apply fresh xyEntities position before prediction calculation
            const freshUpdate = serverUpdates.get(numericId);
            if (freshUpdate) {
                if (typeof freshUpdate.x === 'number') ent.x = freshUpdate.x;
                if (typeof freshUpdate.y === 'number') ent.y = freshUpdate.y;
            }

            enemies.push({ numericId, ent });
        }

        updateEnemyPrediction(enemies.map(e => e.ent));

        let bounceZones = [];
        if (game.area && game.area.zones) {
            bounceZones = game.area.zones.list().filter(z => z.type === 0);
        }

        const predMs = window.__enemySmoothPendingTicks > 0 ? window.__enemySmoothPendingTicks * SERVER_TICK_MS : (window._client.ping || 0) * 0.5 + SERVER_TICK_MS;

        precomputeTrajectories(enemies.map(e => e.ent), predMs + 50, bounceZones);

        // Clean up stale enemies from prediction state
        const activeIds = new Set(enemies.map(e => String(e.numericId)));
        for (const id of Object.keys(window.__enemyPredState)) {
            if (!activeIds.has(id)) delete window.__enemyPredState[id];
        }

        // Update prediction state on server message
        for (const { numericId, ent } of enemies) {
            const id = String(numericId);
            const state = window.__enemyPredState[id];

            window.__enemyPredState[id] = {
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
                radius: ent.radius
            };
        }
    };

    // ==================== PRE/POST RENDER POSITION SWAP ====================
    window._client.preRender = (gameState) => {
        __savedPositions.clear();
        window.__playerRealPos = undefined;
        if (!isOverlayEnabled || !gameState?.entities) return;

        try {
            const now = performance.now();
            if (!window.__lastEnemyFrameTime) window.__lastEnemyFrameTime = now;
            const dtMs = Math.min(now - window.__lastEnemyFrameTime, 50);
            window.__lastEnemyFrameTime = now;

            const selfId = gameState.selfId;
            const selfEnt = gameState.entities[selfId];
            // ---- Update player prediction BEFORE swapping ----
            if (isPredictPlayerEnabled && window.__getSmoothCameraPrediction) {
                const game = getGameRef();
                if (game?.player) {
                    window.__getSmoothCameraPrediction(game.player, game);
                    window.__predictionCalculatedThisFrame = true;
                }
            }

            const pd = window.__predictData;
            const hasPlayerPrediction = isPredictPlayerEnabled && pd && (now - pd.time) < 100;

            // ---- Swap player position in all locations ----
            if (hasPlayerPrediction && selfId != null) {
                if (selfEnt) {
                    window.__playerRealPos = { x: selfEnt.x, y: selfEnt.y };
                    __savedPositions.set(String(selfId), { ent: selfEnt, x: selfEnt.x, y: selfEnt.y });
                    selfEnt.x = pd.x;
                    selfEnt.y = pd.y;
                }
                // Also swap in globalEntities
                if (Array.isArray(gameState.globalEntities)) {
                    for (const gEnt of gameState.globalEntities) {
                        if (gEnt && gEnt.id === selfId && gEnt !== selfEnt) {
                            __savedPositions.set('_gEnt_' + selfId, { ent: gEnt, x: gEnt.x, y: gEnt.y });
                            gEnt.x = pd.x;
                            gEnt.y = pd.y;
                        }
                    }
                }
                // Also swap gameState.self.entity
                const selfEntity = gameState.self?.entity;
                if (selfEntity && selfEntity !== selfEnt) {
                    __savedPositions.set('_selfEnt_', { ent: selfEntity, x: selfEntity.x, y: selfEntity.y });
                    selfEntity.x = pd.x;
                    selfEntity.y = pd.y;
                }
            }

            // ---- Hide self visibility ----
            if (selfId != null) {
                const selfEnt = gameState.entities[selfId];
                if (selfEnt) {
                    if (isHideSelfEnabled) {
                        if (!originalSelfProps) originalSelfProps = { isDeparted: selfEnt.isDeparted };
                        selfEnt.isDeparted = true;
                    } else if (originalSelfProps) {
                        selfEnt.isDeparted = originalSelfProps.isDeparted;
                        originalSelfProps = null;
                    }
                }
            }

            // ---- Swap gloop positions to follow predicted player ----
            if (hasPlayerPrediction && window.__playerRealPos && selfEnt?.hasRadioactiveGloop) {
                const offsetX = pd.x - window.__playerRealPos.x;
                const offsetY = pd.y - window.__playerRealPos.y;
                const realPX = window.__playerRealPos.x;
                const realPY = window.__playerRealPos.y;

                for (const [gId, gEnt] of Object.entries(gameState.entities)) {
                    if (gEnt.entityType !== 136) continue;
                    if (gEnt.inactive === true) continue;

                    // Only shift gloops near our real position
                    const distToPlayer = Math.hypot(gEnt.x - realPX, gEnt.y - realPY);
                    if (distToPlayer > 30) continue; // Only shift gloops within 30 units of the player

                    __savedPositions.set('_gloop_' + gId, { ent: gEnt, x: gEnt.x, y: gEnt.y });
                    gEnt.x += offsetX;
                    gEnt.y += offsetY;
                }
            }

            // ---- Enemy prediction ----
            for (const [id, ent] of Object.entries(gameState.entities)) {
                const isSelf = ent.isLocalPlayer === true || id === String(selfId);
                if (isSelf) continue;

                // ---- Enemy prediction ----
                if (!ent.isEnemy || ent.isPlayer) continue;
                if (ent.entityType === 130 || _ignoredTypes.has(ent.entityType)) continue;
                if ((ent.name || '').toLowerCase().includes('switch')) continue;

                const state = window.__enemyPredState ? window.__enemyPredState[id] : null;
                if (!state) continue;

                // Apply type-specific client side prediction behaviors (e.g. Icicle wall hit clock)
                predictEntityBehavior(ent, dtMs);

                const currentMultiplier = ent.speedMultiplier !== undefined ? ent.speedMultiplier : 1;
                let hasVelocity = (Math.abs(state.vxMs) > 0.0001 || Math.abs(state.vyMs) > 0.0001) && currentMultiplier > 0;

                // Force position trajectory interpolation for type 71 to simulate unfreezing correctly
                if (ent.entityType === 71) hasVelocity = true;
                if (ent.entityType === 30) hasVelocity = true;

                let savedRadius = undefined;

                if (hasVelocity) {
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
                            if (trajPos.radius !== undefined && ent.radius !== trajPos.radius) {
                                savedRadius = ent.radius;
                                ent.radius = trajPos.radius;
                            }
                        }
                    }

                    // Fallback to straight line if trajectory failed
                    if (idealX === undefined) {
                        idealX = state.serverBaseX + state.vxMs * renderTimeMs;
                        idealY = state.serverBaseY + state.vyMs * renderTimeMs;
                    }

                    // Disabling lerp for dripping
                    if (ent.entityType === 30) {
                        state.smoothX = idealX;
                        state.smoothY = idealY;
                    } else {
                        // 4. Smoothly blend towards the ideal position to hide micro-jumps from server corrections
                        const lerpFactor = 1 - Math.pow(0.2, dtMs / 16.66);
                        state.smoothX += (idealX - state.smoothX) * lerpFactor;
                        state.smoothY += (idealY - state.smoothY) * lerpFactor;
                    }

                    __savedPositions.set(id, { ent, x: ent.x, y: ent.y, radius: savedRadius });
                    ent.x = state.smoothX;
                    ent.y = state.smoothY;
                } else {
                    // If an enemy has stopped (e.g. frozen by ability) render it at its server position
                    __savedPositions.set(id, { ent, x: ent.x, y: ent.y, radius: savedRadius });
                    ent.x = state.serverBaseX;
                    ent.y = state.serverBaseY;
                    state.smoothX = state.serverBaseX;
                    state.smoothY = state.serverBaseY;
                }

                // Icicle clock tracking on original entity
                if (ent.entityType === 71 && ent._wallHit) {
                    if (ent._clock === undefined) ent._clock = 0;
                    ent._clock += dtMs;
                }
            }
        } catch (e) {
            console.error('[AntiPing] preRender error:', e);
        }
    };

    window._client.postRender = (gameState) => {
        try {
            for (const [key, saved] of __savedPositions) {
                const ent = saved.ent;
                if (ent) {
                    ent.x = saved.x;
                    ent.y = saved.y;
                    if (saved.radius !== undefined) ent.radius = saved.radius;
                }
            }
        } catch (e) {
            console.error('[AntiPing] postRender error:', e);
        }
        __savedPositions.clear();
    };

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

    // ========== INJECTION INTO AREA (ENGINE RENDER LOOP) ==========
    function runRenderHook() {
        const game = getGameRef();
        if (!game || !game.area || !game.camera) return;

        if (currentArea !== game.area) {
            currentArea = game.area;
        }

        if (currentArea && !currentArea._originalRender) {
            currentArea._originalRender = currentArea.render;

            currentArea.render = function (nativeCtx, cam) {
                const liveGame = getGameRef();

                if (!isOverlayEnabled) {
                    return this._originalRender.call(this, nativeCtx, cam);
                }

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
    const scriptsBtn = createBtn(60, `🎨 Scripts [${isOverlayEnabled ? 'ON' : 'OFF'}]`, isOverlayEnabled ? '#0f0' : '#f00', () => {
        isOverlayEnabled = !isOverlayEnabled;
        window.toggleCam()
        saveSetting('antiping_scripts', isOverlayEnabled);
        if (!isOverlayEnabled) {
            const game = getGameRef();
            if (game) {
                if (originalSelfProps && game.gameState?.entities?.[game.gameState.selfId]) {
                    game.gameState.entities[game.gameState.selfId].isDeparted = originalSelfProps.isDeparted;
                    originalSelfProps = null;
                }
            }
        }

        scriptsBtn.innerText = `🎨 Scripts [${isOverlayEnabled ? 'ON' : 'OFF'}]`;
        scriptsBtn.style.borderColor = isOverlayEnabled ? '#0f0' : '#f00';

        selfBtn.innerText = `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`;
        selfBtn.style.borderColor = isHideSelfEnabled ? '#f0f' : '#ffa';
        predictPlayerBtn.innerText = `🚀 PREDICT PLAYER [${isPredictPlayerEnabled ? 'ON' : 'OFF'}]`;
        predictPlayerBtn.style.borderColor = isPredictPlayerEnabled ? '#0f0' : '#f00';
    });

    const selfBtn = createBtn(110, `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`, isHideSelfEnabled ? '#f0f' : '#ffa', () => {
        isHideSelfEnabled = !isHideSelfEnabled;
        saveSetting('antiping_hideself', isHideSelfEnabled);
        selfBtn.innerText = `👤 HIDE SELF [${isHideSelfEnabled ? 'ON' : 'OFF'}]`;
        selfBtn.style.borderColor = isHideSelfEnabled ? '#f0f' : '#ffa';
    });

    const predictPlayerBtn = createBtn(160, `🚀 PREDICT PLAYER [${isPredictPlayerEnabled ? 'ON' : 'OFF'}]`, isPredictPlayerEnabled ? '#0f0' : '#f00', () => {
        isPredictPlayerEnabled = !isPredictPlayerEnabled;
        saveSetting('antiping_predictp', isPredictPlayerEnabled);
        predictPlayerBtn.innerText = `🚀 PREDICT PLAYER [${isPredictPlayerEnabled ? 'ON' : 'OFF'}]`;
        predictPlayerBtn.style.borderColor = isPredictPlayerEnabled ? '#0f0' : '#f00';
    });

    const unlockFPSBtn = createBtn(210, window._client.unlockFPS ? '🔓 Unlock FPS [ON]' : '🔒 Unlock FPS [OFF]', window._client.unlockFPS ? '#0f0' : '#ffa500', () => {
        window._client.unlockFPS = !window._client.unlockFPS;
        saveSetting('antiping_unlockfps', window._client.unlockFPS);
        unlockFPSBtn.innerText = window._client.unlockFPS ? '🔓 Unlock FPS [ON]' : '🔒 Unlock FPS [OFF]';
        unlockFPSBtn.style.borderColor = window._client.unlockFPS ? '#0f0' : '#ffa500';
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'PageUp') {
            e.preventDefault();
            isUIVisible = !isUIVisible;
            [scriptsBtn, selfBtn, predictPlayerBtn, unlockFPSBtn].forEach(b => b.style.display = isUIVisible ? 'block' : 'none');
        }
    });

    setInterval(runRenderHook, 32);
})();