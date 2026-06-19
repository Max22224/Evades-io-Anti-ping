// ==UserScript==
// @name         Movement predict v6.5
// @namespace    https://evades.io/
// @version      6.5
// @description  Restored exact sandbox physics (independent axis clipping)
// @match        https://*.evades.io/*
// @match        https://*.evades.online/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    let isEnabled = true;
    let isDebugVisible = false;
    let currentArea = null;
    let originalRender = null;

    // Состояния для способностей и отслеживания смены героя
    let isMagmaxAbilityActive = false;
    let lastHeroType = null;

    // Таймеры действия яда (в тиках)
    let poisonGhostTimer = 0;
    let poisonSniperTimer = 0;

    let PREDICT_TICKS = 6;

    // ГЛОБАЛЬНЫЕ ДЛЯ СКРИПТА ПЕРЕМЕННЫЕ
    const entityVelocities = new Map();
    let lastAuraCheckTime = performance.now();

    // Отслеживание мыши и Shift в реальном времени
    let currentMouseX = window.innerWidth / 2;
    let currentMouseY = window.innerHeight / 2;

    // Создание HTML-панели дебага
    const debugDiv = document.createElement('div');
    debugDiv.id = 'evades-predict-debug';
    debugDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 20px;
        background: rgba(10, 10, 10, 0.85);
        color: #00ff66;
        font-family: 'Courier New', Courier, monospace;
        font-size: 13px;
        padding: 12px;
        border-radius: 6px;
        border: 1px solid #00ff66;
        box-shadow: 0 0 15px rgba(0, 255, 102, 0.3);
        z-index: 999999;
        display: none;
        pointer-events: none;
        line-height: 1.5;
        min-width: 270px;
    `;
    document.body.appendChild(debugDiv);

    // Слушатели клавиатуры и мыши
    window.addEventListener('mousemove', (e) => {
        currentMouseX = e.clientX;
        currentMouseY = e.clientY;
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Home' || e.code === 'Home') {
            isDebugVisible = !isDebugVisible;
            debugDiv.style.display = isDebugVisible ? 'block' : 'none';
        }

        if (e.altKey && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) {
            const game = getGameRef();
            if (game && game.player && game.player.heroType == 17) {
                e.preventDefault();
                isMagmaxAbilityActive = !isMagmaxAbilityActive;
            }
        }
    });

    // Универсальный безопасный итератор для любых типов коллекций (Map, Array, Object)
    function safeForEach(collection, callback) {
        if (!collection) return;
        if (typeof collection.forEach === 'function') {
            collection.forEach((val, key) => callback(val, key));
        } else if (typeof collection[Symbol.iterator] === 'function') {
            for (const val of collection) callback(val);
        } else if (Array.isArray(collection)) {
            for (let i = 0; i < collection.length; i++) callback(collection[i], i);
        } else if (typeof collection === 'object') {
            for (const key in collection) {
                if (Object.prototype.hasOwnProperty.call(collection, key)) {
                    callback(collection[key], key);
                }
            }
        }
    }

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
                        gameState: stateNode.gameState,
                        entities: stateNode.gameState.entities
                    };
                }
                fiber = fiber.return;
                depth++;
            }
        } catch (e) { }
        return null;
    }

    function getActiveAuras(player, game, futurePx, futurePy) {
        let aura = { slow: 0, slippery: false, pullX: 0, pullY: 0 };
        const entities = game.entities || game.gameState?.entities;
        if (!entities) return aura;

        const pX = futurePx !== undefined ? futurePx : ((player.pos && player.pos.x !== undefined) ? player.pos.x : player.x);
        const pY = futurePy !== undefined ? futurePy : ((player.pos && player.pos.y !== undefined) ? player.pos.y : player.y);
        const pRadPx = player.radius || 15;

        const now = performance.now();
        const dt = (now - lastAuraCheckTime) / 1000;
        const isValidDt = dt > 0.005 && dt < 0.5;

        for (const [entId, ent] of Object.entries(entities)) {
            if (!ent || ent === player) continue;

            const currentEntX = (ent.pos && ent.pos.x !== undefined) ? ent.pos.x : ent.x;
            const currentEntY = (ent.pos && ent.pos.y !== undefined) ? ent.pos.y : ent.y;
            if (currentEntX === undefined || currentEntY === undefined) continue;

            let entVx = 0, entVy = 0;
            if (entId) {
                let state = entityVelocities.get(entId);
                if (!state) {
                    state = { vx: 0, vy: 0, lastX: currentEntX, lastY: currentEntY, updatedAt: now };
                    entityVelocities.set(entId, state);
                } else {
                    if (isValidDt && (currentEntX !== state.lastX || currentEntY !== state.lastY)) {
                        const rawVx = (currentEntX - state.lastX) / (dt * 60);
                        const rawVy = (currentEntY - state.lastY) / (dt * 60);
                        const filter = 0.3;
                        state.vx = state.vx * (1 - filter) + rawVx * filter;
                        state.vy = state.vy * (1 - filter) + rawVy * filter;
                        state.lastX = currentEntX;
                        state.lastY = currentEntY;
                        state.updatedAt = now;
                    }
                    entVx = state.vx;
                    entVy = state.vy;
                }
            }

            const predictedEntX = currentEntX + (entVx * PREDICT_TICKS);
            const predictedEntY = currentEntY + (entVy * PREDICT_TICKS);
            const dist = Math.hypot(predictedEntX - pX, predictedEntY - pY);

            const entType = ent.entityType ?? ent.type ?? '';
            let isGravity = (entType == 63);
            let isRepelling = (entType == 142);
            let gravityForce = (ent.gravity !== undefined) ? ent.gravity : (6 / 32);
            let repulsionForce = (ent.repulsion !== undefined) ? ent.repulsion : (6 / 32);
            let currentAuraSize = 0;

            const effs = (window.__originalEffects && window.__originalEffects.has(entId))
                ? window.__originalEffects.get(entId)
                : (ent.effects && ent.effects.effects ? ent.effects.effects : null);

            if (effs) {
                for (const effKey in effs) {
                    const eff = effs[effKey];
                    if (!eff) continue;
                    const effType = eff.effectType ?? eff.type ?? '';
                    const effRadius = eff.radius !== undefined ? eff.radius : null;

                    if (effType == 50) {
                        isGravity = true;
                        if (effRadius) currentAuraSize = effRadius;
                        if (eff.gravity) gravityForce = eff.gravity;
                    } else if (effType == 51) {
                        isRepelling = true;
                        if (effRadius) currentAuraSize = effRadius;
                        if (eff.repulsion) repulsionForce = eff.repulsion;
                    }
                    // Check first contact: player edge touches aura edge (dist <= playerRadius + effRadius)
                    if (effRadius && dist < effRadius + pRadPx) {
                        if (effType == 48) aura.slow = Math.max(aura.slow, 0.3);
                        else if (effType == 70) aura.slow = Math.max(aura.slow, 0.2);
                        else if (effType == 52) aura.slow = Math.max(aura.slow, 0.85);
                        else if (effType == 53) aura.slippery = true;
                    }
                }
            }

            if (isGravity || isRepelling) {
                if (dist <= (pRadPx + currentAuraSize)) {
                    const isInvuln = typeof player.isInvulnerable === 'function' ? player.isInvulnerable() : (player.isInvulnerable || player.invulnerable);
                    if (!isInvuln) {
                        const effectImmune = (player.effectImmune !== undefined) ? player.effectImmune : 1;
                        const amplitude = Math.pow(2, -(dist / (100 / 32)));
                        const dx = pX - predictedEntX;
                        const dy = pY - predictedEntY;
                        const angleToPlayer = Math.atan2(dy, dx);
                        if (isGravity) {
                            const moveDist = gravityForce * amplitude * effectImmune;
                            aura.pullX -= moveDist * Math.cos(angleToPlayer);
                            aura.pullY -= moveDist * Math.sin(angleToPlayer);
                        }
                        if (isRepelling) {
                            const moveDist = repulsionForce * amplitude * effectImmune;
                            aura.pullX += moveDist * Math.cos(angleToPlayer);
                            aura.pullY += moveDist * Math.sin(angleToPlayer);
                        }
                    }
                }
            }
        }

        if (isValidDt) lastAuraCheckTime = now;

        const checkPlayerEffect = (eff) => {
            if (!eff) return;
            const effType = eff.effectType ?? eff.type ?? '';
            if (effType == 48) aura.slow = Math.max(aura.slow, 0.3);
            else if (effType == 70) aura.slow = Math.max(aura.slow, 0.2);
            else if (effType == 52) aura.slow = Math.max(aura.slow, 0.85);
            else if (effType == 53) aura.slippery = true;
        };

        if (player.effects) {
            if (player.effects.effects) safeForEach(player.effects.effects, checkPlayerEffect);
            else safeForEach(player.effects, checkPlayerEffect);
        }
        if (player.statusEffects) safeForEach(player.statusEffects, checkPlayerEffect);
        if (player.debuffs) safeForEach(player.debuffs, checkPlayerEffect);

        return aura;
    }

    function isPlayerInSafeZone(player, game) {
        const pX = (player.pos && player.pos.x !== undefined) ? player.pos.x : player.x;
        const pY = (player.pos && player.pos.y !== undefined) ? player.pos.y : player.y;

        let zonesList = game.area.zones.list();

        for (const zone of zonesList) {
            if (zone.type === 4) {
                if (pX >= zone.x && pX <= zone.x + zone.width &&
                    pY >= zone.y && pY <= zone.y + zone.height) {
                    return true;
                }
            }
        }
        return false;
    }

    function getSmoothCameraPrediction(player, game) {
        const pX = (player.pos && player.pos.x !== undefined) ? player.pos.x : player.x;
        const pY = (player.pos && player.pos.y !== undefined) ? player.pos.y : player.y;
        const camera = game?.camera;

        // ================= ZONE FRICTION =================
        let zoneFriction = 0.75;
        if (game.area && game.area.friction !== undefined) {
            zoneFriction = game.area.friction;
        } else if (game.gameState?.worlds && player.world !== undefined && player.area !== undefined) {
            const currentWorld = game.gameState.worlds[player.world];
            const currentAreaObj = currentWorld?.areas[player.area];
            if (currentAreaObj?.friction !== undefined) zoneFriction = currentAreaObj.friction;
        }
        if (player.slippery) zoneFriction = 0;

        const isDead = player.isDead || player.dead || (player.deathTimer !== undefined && player.deathTimer !== -1);
        const hasMouseControl = !!(game.gameState && game.gameState.mouseDown);
        const isVoid = player.voidTime !== undefined && player.voidTime !== 0;

        if (player.heroType !== lastHeroType) {
            lastHeroType = player.heroType;
            isMagmaxAbilityActive = false;
        }

        // ================= HARD RESET =================
        if (isDead || isVoid) {
            window.__predVelState = { vx: 0, vy: 0 };
            window.__smoothPendingTicks = 0;
            window.__smoothPredX = undefined;
            window.__smoothPredY = undefined;
            window.__predictData = { x: pX, y: pY, time: performance.now() };
            if (isDebugVisible) {
                updateDebugUI(0, 0, 0, 0, isVoid, false, player.voidTime || 0, player.isIced === true, isMagmaxAbilityActive, false, 0, 150, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
            }
            return { x: pX, y: pY };
        }

        if (poisonGhostTimer > 0) poisonGhostTimer--;
        if (poisonSniperTimer > 0) poisonSniperTimer--;

        try {
            const pRadius = player.radius || 15;
            const collectionsToScan = [
                game.entities,
                game.gameState?.entities,
                game.gameState?.projectiles,
                game.gameState?.areaInfo?.projectiles
            ];

            for (const collection of collectionsToScan) {
                if (!collection) continue;
                safeForEach(collection, (ent) => {
                    if (!ent || ent === player) return;

                    const entType = ent.entityType ?? ent.type ?? ent.enemyType ?? ent.projectileType ?? ent.id ?? ent.typeId;
                    const entName = String(ent.name || ent.label || '').toLowerCase();

                    const isPoisonGhost = (entType == 120) || entName.includes('poisonghost') || entName.includes('poison_ghost');
                    const isPoisonSniper = (entType == 121 || entType == 122) || entName.includes('poisonsniper') || entName.includes('poison_sniper');

                    if (isPoisonGhost || isPoisonSniper) {
                        const entX = (ent.pos && ent.pos.x !== undefined) ? ent.pos.x : ent.x;
                        const entY = (ent.pos && ent.pos.y !== undefined) ? ent.pos.y : ent.y;

                        if (entX === undefined || entY === undefined) return;

                        const dist = Math.hypot(entX - pX, entY - pY);
                        const entRadius = ent.radius ?? ent.size ?? ent.width ?? 15;

                        if (dist < (pRadius + entRadius)) {
                            if (isPoisonGhost) poisonGhostTimer = 15;
                            if (isPoisonSniper) poisonSniperTimer = 60;
                        }
                    }
                });
            }
        } catch (err) { }

        // ================= AURA & SPEED CALCULATION =================
        const aura = getActiveAuras(player, game, pX, pY);

        // ================= SAFE ZONE LOGIC =================
        const inSafeZone = isPlayerInSafeZone(player, game);
        if (inSafeZone) {
            aura.slow = 0;
            aura.slippery = false;
            aura.pullX = 0;
            aura.pullY = 0;
        }

        if (aura.slippery || player.slippery) {
            zoneFriction = 0;
        }

        let baseSpeed = player.calculateSpeed ? player.calculateSpeed(0) : (player.speed || 0);
        const maxPoisonTicks = Math.max(poisonGhostTimer, poisonSniperTimer);
        if (maxPoisonTicks > 0) baseSpeed *= 3;

        let effectiveSlow = 0;
        if (player.isIced === true) {
            baseSpeed = 0;
        } else {
            let slowReduction = 0;
            if (player.mutatiorbBuffEffectsReduction === true) {
                slowReduction = (player.heroType == 10) ? 0.60 : 0.40;
            }
            effectiveSlow = aura.slow * (1 - slowReduction);
            baseSpeed *= (1 - Math.min(1, Math.max(0, effectiveSlow)));
        }

        let additionalSpeed = 0;
        if (player.mutatiorbBuffSpeedBoost === true) additionalSpeed += (player.heroType == 10) ? 90 : 60;
        if (player.sweetToothConsumed === true) additionalSpeed += 150;

        if (player.heroType == 17 && isMagmaxAbilityActive) {
            const ab1 = player.abilityOne;
            if (ab1 && (ab1.abilityType == 28 || ab1.type == 28) && ab1.level >= 1) {
                const magmaxSpeeds = [60, 90, 120, 150, 180];
                additionalSpeed += magmaxSpeeds[Math.min(ab1.level - 1, 4)];
            }
        }

        const isNightActive = !!(player.nightActivated || player.abilityOne?.nightActivated || player.night);
        if (isNightActive) {
            const ab1 = player.abilityOne;
            if (ab1 && (ab1.abilityType == 59 || ab1.type == 59)) {
                const lvl = ab1.level ?? 0;
                if (lvl >= 1) {
                    const shadeSpeeds = [0, 37.5, 75, 112.5, 150];
                    additionalSpeed += shadeSpeeds[Math.min(lvl - 1, shadeSpeeds.length - 1)];
                }
            }
        }

        let finalMovementSpeed = baseSpeed + additionalSpeed;

        // In safe zones, minimum speed is 10 (300 units per second)
        if (inSafeZone && finalMovementSpeed < 300) {
            finalMovementSpeed = 300;
        }

        const iceSpeed = player.calculateSpeedChanges ? player.calculateSpeedChanges(player.speed) : (player.speed || 0);
        let currentIceSpeed = iceSpeed;
        if (baseSpeed === 0 && additionalSpeed > 0) currentIceSpeed = additionalSpeed;

        const ab2 = player.abilityTwo;
        if (ab2 && ab2.abilityType == 98 && ab2.locked === false && ab2.level === 1 && !player.isStickyCoatDisabled) {
            try {
                const entitiesList = game.entities || game.gameState?.entities;
                let isPlayerSticky = false;
                if (entitiesList) {
                    safeForEach(entitiesList, (ent) => {
                        if (!ent || !ent.isPlayer) return;
                        if (ent.IsLocalPlayer || ent.isLocalPlayer || ent === player) return;
                        const entX = (ent.pos && ent.pos.x !== undefined) ? ent.pos.x : ent.x;
                        const entY = (ent.pos && ent.pos.y !== undefined) ? ent.pos.y : ent.y;
                        const distanceToTarget = Math.hypot(entX - pX, entY - pY);
                        if (distanceToTarget <= 30) {
                            const ts = ent.totalspeed !== undefined ? ent.totalspeed : ent.totalSpeed;
                            const s = ent.speed;
                            const invuln = ent.IsInvulnerable || ent.isInvulnerable || ent.invulnerable;
                            const hasTargetSpeed = (ts === 0 || ts === 30 || ts === 60 || ts === 90 || ts === 120 || (ts === 150 && s !== 150));
                            if (hasTargetSpeed && invuln) isPlayerSticky = true;
                        }
                    });
                }
                if (isPlayerSticky) finalMovementSpeed *= 0.8;
            } catch (e) { }
        }

        // ================= CURRENT INPUT (from input hook, same space as cmd.x/y) =================
        let currentDirX = 0;
        let currentDirY = 0;

        if (hasMouseControl) {
            const lastMd = window._client._lastMouseDownPos;
            if (lastMd) {
                currentDirX = lastMd.x;
                currentDirY = lastMd.y;
            } else {
                // Fallback: canvas-based calculation only if hook hasn't fired yet
                const canvasRect = document.querySelector('canvas')?.getBoundingClientRect();
                const screenCenterX = canvasRect ? canvasRect.width / 2 : window.innerWidth / 2;
                const screenCenterY = canvasRect ? canvasRect.height / 2 : window.innerHeight / 2;
                const mouseCanvasX = currentMouseX - (canvasRect ? canvasRect.left : 0);
                const mouseCanvasY = currentMouseY - (canvasRect ? canvasRect.top : 0);
                currentDirX = mouseCanvasX - screenCenterX;
                currentDirY = mouseCanvasY - screenCenterY;
            }
        }

        // ================= COMMAND REPLAY OFFSET =================
        const acked = window._client.selfAcked;
        const history = window._client.selfCmdHistory || [];
        const pending = acked ? history.filter(cmd => cmd.seq > acked.seq) : [];

        // Smooth pending tick count (faster 0.65/0.35 for high ping stability)
        const rawPendingTicks = pending.length + 1;
        if (window.__smoothPendingTicks == null) window.__smoothPendingTicks = rawPendingTicks;
        window.__smoothPendingTicks += (rawPendingTicks - window.__smoothPendingTicks) * 0.35;

        const integerTicks = Math.floor(window.__smoothPendingTicks);
        const fractionalPart = window.__smoothPendingTicks - integerTicks;

        // Build input sequence
        const inputsToReplay = pending.map(cmd => ({ x: cmd.x, y: cmd.y }));

        // Determine the input state for padding future ticks.
        // If mouse is held, assume we keep holding it. If released, assume we keep it released (coast).
        const padInput = hasMouseControl ? { x: currentDirX, y: currentDirY } : { x: 0, y: 0 };
        inputsToReplay.push(padInput);

        // Pad extra ticks to cover the smoothing prediction window without falsely simulating mouse release
        while (inputsToReplay.length < integerTicks + 2) {
            inputsToReplay.push(padInput);
        }

        let x = pX;
        let y = pY;

        if (!window.__predVelState) window.__predVelState = { vx: 0, vy: 0 };
        let lastVx = window.__predVelState.vx;
        let lastVy = window.__predVelState.vy;
        let finalStepVx = lastVx;
        let finalStepVy = lastVy;

        const maxTicksToProcess = integerTicks + 1;
        for (let i = 0; i < maxTicksToProcess; i++) {
            const input = inputsToReplay[i];
            const mag = Math.hypot(input.x || 0, input.y || 0);

            let stepX = 0;
            let stepY = 0;

            if (mag < 1) {
                // COAST TICK — friction clip applies here
                const coastFactor = 1 - zoneFriction;
                lastVx *= coastFactor;
                lastVy *= coastFactor;
                if (Math.abs(lastVx) > 0 && Math.abs(lastVx) < zoneFriction) lastVx = 0;
                if (Math.abs(lastVy) > 0 && Math.abs(lastVy) < zoneFriction) lastVy = 0;
                stepX = lastVx;
                stepY = lastVy;
            } else {
                // ACTIVE TICK — no friction clip
                const ux = input.x / mag;
                const uy = input.y / mag;
                const moveScale = Math.min(1, mag / 150);
                const velocityPerTick = finalMovementSpeed / 60;
                const distancePerTick = velocityPerTick * moveScale;

                stepX = ux * distancePerTick;
                stepY = uy * distancePerTick;

                if (zoneFriction > 0) {
                    const absStepX = Math.abs(stepX);
                    const absStepY = Math.abs(stepY);
                    if (absStepX > velocityPerTick) stepX *= velocityPerTick / absStepX;
                    if (absStepY > velocityPerTick) stepY *= velocityPerTick / absStepY;
                } else {
                    const icePerTick = currentIceSpeed / 60;
                    const prevMag = Math.hypot(lastVx, lastVy);
                    if (prevMag > 0.05) {
                        stepX = (lastVx / prevMag) * icePerTick;
                        stepY = (lastVy / prevMag) * icePerTick;
                    } else {
                        stepX = ux * icePerTick;
                        stepY = uy * icePerTick;
                    }
                }
                lastVx = stepX;
                lastVy = stepY;
            }

            finalStepVx = lastVx;
            finalStepVy = lastVy;

            const tickPullX = aura.pullX;
            const tickPullY = aura.pullY;

            if (i < integerTicks) {
                x += stepX + tickPullX;
                y += stepY + tickPullY;
            } else if (i === integerTicks) {
                x += (stepX + tickPullX) * fractionalPart;
                y += (stepY + tickPullY) * fractionalPart;
            }
        }

        window.__predVelState = { vx: finalStepVx, vy: finalStepVy };

        if (game.area) {
            const radius = player.radius || 15;
            let rawZones = [];
            let walkableZones = [];
            if (game.area.zones) {
                // Only consider walkable zone types (0=active, 2=exit (area switches (area 1->2)), 4=safe, 5=teleport (map switches), 6=victory) for player boundary logic
                const _walkableTypeSet = new Set([0, 4, 6]);
                rawZones = game.area.zones.list();
                walkableZones = rawZones.filter(z => _walkableTypeSet.has(z.type));
            }
            let playerZones = [];
            for (let i = 0; i < rawZones.length; i++) {
                const zone = rawZones[i];
                if (pX >= zone.x && pX <= zone.x + zone.width && pY >= zone.y && pY <= zone.y + zone.height) {
                    playerZones.push(zone);
                }
            }

            if (playerZones.length === 0) {
                playerZones.push({ x: 0, y: 0, width: game.area.width || 9999, height: game.area.height || 9999 });
            }

            if (walkableZones.length > 0) {
                const isInsideWalkableZone = (x, y) => {
                    for (let i = 0; i < walkableZones.length; i++) {
                        const zone = walkableZones[i];
                        if (x >= zone.x && x <= zone.x + zone.width &&
                            y >= zone.y && y <= zone.y + zone.height) {
                            return true;
                        }
                    }
                    return false;
                };

                let currentMinX = Math.min(...playerZones.map(z => z.x));
                let currentMaxX = Math.max(...playerZones.map(z => z.x + z.width));
                let currentMinY = Math.min(...playerZones.map(z => z.y));
                let currentMaxY = Math.max(...playerZones.map(z => z.y + z.height));

                if (x - pX > 0) {
                    if (!isInsideWalkableZone(x + radius, pY)) x = Math.min(x, currentMaxX - radius);
                } else if (x - pX < 0) {
                    if (!isInsideWalkableZone(x - radius, pY)) x = Math.max(x, currentMinX + radius);
                }
                if (y - pY > 0) {
                    if (!isInsideWalkableZone(pX, y + radius)) y = Math.min(y, currentMaxY - radius);
                } else if (y - pY < 0) {
                    if (!isInsideWalkableZone(pX, y - radius)) y = Math.max(y, currentMinY + radius);
                }
            } else {
                const maxWidth = game.area.width || 0;
                const maxHeight = game.area.height || 0;
                if (maxWidth > 0) x = Math.max(radius, Math.min(maxWidth - radius, x));
                if (maxHeight > 0) y = Math.max(radius, Math.min(maxHeight - radius, y));
            }
        }

        // ================= TELEPORT / MAP CHANGE SNAP =================
        // If the player position suddenly jumps (teleporter, map change, respawn),
        // force the smoothing variables to snap instantly to prevent the camera from flying through the void.
        if (window.__smoothPredX !== undefined) {
            const jumpDist = Math.hypot(pX - window.__smoothPredX, pY - window.__smoothPredY);
            if (jumpDist > 150) { // Threshold for a teleport/server snap
                window.__smoothPredX = pX;
                window.__smoothPredY = pY;
                window.__predVelState = { vx: 0, vy: 0 };
                x = pX;
                y = pY;
            }
        }

        // ================= OUTPUT SMOOTHING =================
        if (window.__smoothPredX === undefined) {
            window.__smoothPredX = x;
            window.__smoothPredY = y;
        }
        window.__smoothPredX += (x - window.__smoothPredX) * 0.7;
        window.__smoothPredY += (y - window.__smoothPredY) * 0.7;

        const finalX = window.__smoothPredX;
        const finalY = window.__smoothPredY;

        window.__predictData = { x: finalX, y: finalY, time: performance.now() };

        // ================= DEBUG OVERLAY =================
        if (isDebugVisible) {
            const currentDist = Math.hypot(currentDirX, currentDirY);
            const mouseAngle = Math.atan2(currentDirY, currentDirX);
            const cursorSpeed = (Math.min(1, currentDist / 150)) * finalMovementSpeed;

            let moveAngle = 0;
            const avgMag = Math.hypot(finalStepVx, finalStepVy);
            if (avgMag > 0.05) {
                moveAngle = Math.atan2(finalStepVy, finalStepVx) * (180 / Math.PI);
                if (moveAngle < 0) moveAngle += 360;
            }
            let targetAngle = mouseAngle * (180 / Math.PI);
            if (targetAngle < 0) targetAngle += 360;

            updateDebugUI(
                baseSpeed, additionalSpeed, finalMovementSpeed, effectiveSlow,
                false, (zoneFriction === 0), 0,
                player.isIced === true, isMagmaxAbilityActive, isNightActive,
                maxPoisonTicks, 150, cursorSpeed, currentDist,
                aura.pullX, aura.pullY, window.__smoothPendingTicks,
                finalStepVx * 60, finalStepVy * 60,
                finalStepVx * 60, finalStepVy * 60,
                moveAngle, targetAngle
            );
        }

        return { x: finalX, y: finalY };
    }

    function updateDebugUI(base, add, final, slow, voidState, slipperyState, voidTicks, isIced, magmaxActive, nightActive, poisonTicks, maxMouseDist, cursorSpeed, currentDist, pullX, pullY, dynamicTicks, avgVx, avgVy, predVx, predVy, moveAngle, targetAngle) {
        const pullMag = Math.hypot(pullX, pullY);
        debugDiv.innerHTML = `
            <b style="color: #fff;">[CAMERA PREDICT DEBUG]</b><br>
            <span style="color: #aaa;">----------------------</span><br>
            Base Speed: <span style="color: #fff;">${base.toFixed(2)}</span><br>
            Add Speed:  <span style="color: #ffcc00;">+${add.toFixed(2)}</span><br>
            Max Speed:  <span style="color: #00ffff; font-weight: bold;">${final.toFixed(2)}</span><br>
            <span style="color: #aaa;">--- CURSOR & DYNAMICS ---</span><br>
            Max Mouse R:<span style="color: #ff99ff;"> ${maxMouseDist.toFixed(0)}wu</span><br>
            Real Speed: <span style="color: #ffff00; font-weight: bold;">${cursorSpeed.toFixed(2)}</span><br>
            Vel X (60t):<span style="color: #33ffcc;"> ${avgVx.toFixed(2)}</span><br>
            Vel Y (60t):<span style="color: #33ffcc;"> ${avgVy.toFixed(2)}</span><br>
            Pred X (u/s):<span style="color: #ffcc66;"> ${predVx.toFixed(2)}</span><br>
            Pred Y (u/s):<span style="color: #ffcc66;"> ${predVy.toFixed(2)}</span><br>
            Mouse Dist: <span style="color: #ff9999;">${currentDist.toFixed(1)}wu</span><br>
            Target Ang: <span style="color: #ff9933;">${targetAngle.toFixed(1)}°</span><br>
            Move Angle: <span style="color: #ff55bb; font-weight: bold;">${moveAngle.toFixed(1)}°</span><br>
            <span style="color: #aaa;">--- CONNECTION ---</span><br>
            Pred. Ticks:<span style="color: #ffff00;">${dynamicTicks}</span><br>
            <span style="color: #aaa;">----------------------</span><br>
            Eff. Slow:  <span style="color: ${slow > 0 ? '#ff3333' : '#00ff66'};">${(slow * 100).toFixed(0)}%</span><br>
            Slippery:   <span style="color: ${slipperyState ? '#00ffff' : '#aaa'};">${slipperyState ? 'ACTIVE' : 'NO'}</span><br>
            voidTime:   <span style="color: ${voidState ? '#ff33ff' : '#aaa'};">${voidState ? ('BLOCKED (' + voidTicks + ')') : '0'}</span><br>
            isIced:     <span style="color: ${isIced ? '#33ccff' : '#aaa'}; font-weight: ${isIced ? 'bold' : 'normal'};">${isIced ? 'ICED' : 'NO'}</span><br>
            Magmax Ab1: <span style="color: ${magmaxActive ? '#ff6600' : '#aaa'}; font-weight: ${magmaxActive ? 'bold' : 'normal'};">${magmaxActive ? 'TOGGLED' : 'OFF'}</span><br>
            Night Mode: <span style="color: ${nightActive ? '#cc66ff' : '#aaa'}; font-weight: ${nightActive ? 'bold' : 'normal'};">${nightActive ? 'ACTIVE' : 'OFF'}</span><br>
            Poison Buff:<span style="color: ${poisonTicks > 0 ? '#33ff33' : '#aaa'}; font-weight: ${poisonTicks > 0 ? 'bold' : 'normal'};">${poisonTicks > 0 ? ('x3 (' + poisonTicks + 't)') : 'OFF'}</span><br>
            Aura Pull:  <span style="color: ${pullMag > 0 ? '#ff33ff' : '#aaa'};">${pullMag.toFixed(4)}</span>
        `;
    }

    function runRenderHook() {
        const game = getGameRef();
        if (!game?.area || !game?.camera) return;

        if (currentArea !== game.area) {
            currentArea = game.area;

            if (!currentArea.render._hooked) {
                originalRender = currentArea.render;

                currentArea.render = function (ctx, cam) {
                    const liveGame = getGameRef();

                    if (isEnabled && liveGame && liveGame.player && cam) {
                        const predictedPos = getSmoothCameraPrediction(liveGame.player, liveGame);

                        if (typeof cam.centerOn === 'function') {
                            cam.centerOn(predictedPos);
                        } else {
                            const camWidth = cam.width || cam.w || 1280;
                            const camHeight = cam.height || cam.h || 720;
                            cam.x = predictedPos.x - (camWidth / 2);
                            cam.y = predictedPos.y - (camHeight / 2);
                        }
                    } else if (liveGame && liveGame.player && cam) {
                        if (typeof cam.centerOn === 'function') {
                            cam.centerOn(liveGame.player.pos || liveGame.player);
                        }
                    }

                    return originalRender.call(this, ctx, cam);
                };

                currentArea.render._hooked = true;
            }
        }
    }

    window.toggleCam = () => {
        isEnabled = !isEnabled;
    };

    setInterval(runRenderHook, 16.66);
})();