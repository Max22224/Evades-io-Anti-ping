// ==UserScript==
// @name         Movement predict v6.4.1
// @namespace    https://evades.io/
// @version      6.4.1
// @description  Fixed mouse movement being incorrect on other resolutions
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

    // Массивы для хранения истории сдвигов (динамический размер)
    let predictedStepsX = [];
    let predictedStepsY = [];
    let PREDICT_TICKS = 6;

    // ГЛОБАЛЬНЫЕ ДЛЯ СКРИПТА ПЕРЕМЕННЫЕ
    const entityVelocities = new Map();
    let lastAuraCheckTime = performance.now();

    // Независимый трекер реальной скорости игрока для фикса Slippery/Ice физики
    let lastPlayerX = null;
    let lastPlayerY = null;
    let playerVx = 0;
    let playerVy = 0;
    let lastPlayerVelocityTime = performance.now();

    // Отслеживание мыши и Shift в реальном времени
    let currentMouseX = window.innerWidth / 2;
    let currentMouseY = window.innerHeight / 2;
    let isShiftPressed = false;

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
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') isShiftPressed = true;

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

    window.addEventListener('keyup', (e) => {
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') isShiftPressed = false;
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
        } catch (e) {}
        return null;
    }

    function getActiveAuras(player, game, futurePx, futurePy) {
        let aura = { slow: 0, slippery: false, pullX: 0, pullY: 0 };
        const entities = game.entities || game.gameState?.entities;
        if (!entities) return aura;

        const pX = futurePx !== undefined ? futurePx : ((player.pos && player.pos.x !== undefined) ? player.pos.x : player.x);
        const pY = futurePy !== undefined ? futurePy : ((player.pos && player.pos.y !== undefined) ? player.pos.y : player.y);

        const now = performance.now();
        const dt = (now - lastAuraCheckTime) / 1000;
        const isValidDt = dt > 0.005 && dt < 0.5;

        // Обход сущностей с получением ключа id (строка), совпадающего с ключами в __originalEffects
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

            // Используем сохранённые эффекты, если оригиналы скрыты оверлеем
            const effs = (window.__originalEffects && window.__originalEffects.has(entId))
                ? window.__originalEffects.get(entId)
                : (ent.effects && ent.effects.effects ? ent.effects.effects : null);

            if (effs) {
                for (const effKey in effs) {
                    const eff = effs[effKey];
                    if (!eff) continue;
                    const effType = eff.effectType ?? eff.type ?? '';
                    const effRadius = eff.radius !== undefined? eff.radius  : null;

                    if (effType == 50) {
                        isGravity = true;
                        if (effRadius) currentAuraSize = effRadius;
                        if (eff.gravity) gravityForce = eff.gravity;
                    } else if (effType == 51) {
                        isRepelling = true;
                        if (effRadius) currentAuraSize = effRadius;
                        if (eff.repulsion) repulsionForce = eff.repulsion;
                    }

                    if (effRadius && dist < effRadius) {
                        if (effType == 48) aura.slow = Math.max(aura.slow, 0.3);
                        else if (effType == 70) aura.slow = Math.max(aura.slow, 0.2);
                        else if (effType == 52) aura.slow = Math.max(aura.slow, 0.85);
                        else if (effType == 53) aura.slippery = true;
                    }
                }
            }

            const pRadPx = player.radius || 15;
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

    function getSmoothCameraPrediction(player, game) {
        const pX = (player.pos && player.pos.x !== undefined) ? player.pos.x : player.x;
        const pY = (player.pos && player.pos.y !== undefined) ? player.pos.y : player.y;
        const camera = game?.camera;

        // ================= ДИНАМИЧЕСКИЙ ПРЕДИКТ-ТИК ПО ПИНГУ =================
        let avgPing = 0;
        if (game.gameState?.performanceStats?.pingSamples) {
            const samples = game.gameState.performanceStats.pingSamples;
            if (samples.length >= 5) {
                const lastFive = samples.slice(-5);
                const sum = lastFive.reduce((s, sample) => s + sample.value, 0);
                avgPing = sum / 5;
                const ticksFromPing = avgPing / 16.66;
                const newTicks = Math.ceil(ticksFromPing);
                if (newTicks >= 1) {
                    PREDICT_TICKS = newTicks;
                }
            }
        }

        // Рассчитываем собственную скорость изменения координат игрока (надежный трекер)
        const nowTime = performance.now();
        const pDt = (nowTime - lastPlayerVelocityTime) / 1000;
        const isValidPDt = pDt > 0.005 && pDt < 0.5;

        if (lastPlayerX !== null && lastPlayerY !== null && isValidPDt) {
            if (pX !== lastPlayerX || pY !== lastPlayerY) {
                const rawPVx = (pX - lastPlayerX) / (pDt * 60);
                const rawPVy = (pY - lastPlayerY) / (pDt * 60);
                const pFilter = 0.25;
                playerVx = playerVx * (1 - pFilter) + rawPVx * pFilter;
                playerVy = playerVy * (1 - pFilter) + rawPVy * pFilter;
            } else {
                playerVx *= 0.7;
                playerVy *= 0.7;
            }
        }
        lastPlayerX = pX;
        lastPlayerY = pY;
        lastPlayerVelocityTime = nowTime;

        const isDead = player.isDead || player.dead || (player.deathTimer !== undefined && player.deathTimer !== -1);
        const hasMouseControl = !!(game.gameState && game.gameState.mouseDown);
        const isVoid = player.voidTime !== undefined && player.voidTime !== 0;

        if (player.heroType !== lastHeroType) {
            lastHeroType = player.heroType;
            isMagmaxAbilityActive = false;
        }

        const canvasRect = document.querySelector('canvas')?.getBoundingClientRect();
        const centerX = canvasRect ? (canvasRect.left + canvasRect.width / 2) : (window.innerWidth / 2);
        const centerY = canvasRect ? (canvasRect.top + canvasRect.height / 2) : (window.innerHeight / 2);

        const currentDist = Math.hypot(currentMouseX - centerX, currentMouseY - centerY);

        const globalScale = camera.originalGameScale || camera.scale || 1;
        const mouseDistFullStrength = 150 * globalScale;

        if (isDead || !hasMouseControl || isVoid) {
            predictedStepsX = [];
            predictedStepsY = [];

            entityVelocities.clear();
            lastAuraCheckTime = performance.now();

            lastPlayerX = null;
            lastPlayerY = null;
            playerVx = 0;
            playerVy = 0;
            lastPlayerVelocityTime = performance.now();

            poisonGhostTimer = 0;
            poisonSniperTimer = 0;

            if (isDebugVisible) {
                updateDebugUI(0, 0, 0, 0, isVoid, false, player.voidTime || 0, player.isIced === true, isMagmaxAbilityActive, false, 0, mouseDistFullStrength, 0, currentDist, 0, 0, avgPing, PREDICT_TICKS);
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
        } catch (err) {}

        let projectedOffsetX = 0;
        let projectedOffsetY = 0;
        for (let i = 0; i < predictedStepsX.length; i++) {
            projectedOffsetX += predictedStepsX[i];
            projectedOffsetY += predictedStepsY[i];
        }
        const futurePlayerX = pX + projectedOffsetX;
        const futurePlayerY = pY + projectedOffsetY;

        const aura = getActiveAuras(player, game, futurePlayerX, futurePlayerY);

        const timeFix = 0.5;

        let zoneFriction = 0.75;
        if (game.area && game.area.friction !== undefined) {
            zoneFriction = game.area.friction;
        } else if (game.gameState?.worlds && player.world !== undefined && player.area !== undefined) {
            const currentWorld = game.gameState.worlds[player.world];
            const currentAreaObj = currentWorld?.areas[player.area];
            if (currentAreaObj?.friction !== undefined) zoneFriction = currentAreaObj.friction;
        }

        if (aura.slippery || player.slippery) {
            zoneFriction = 0;
        }

        let baseSpeed = player.calculateSpeed ? player.calculateSpeed(0) : (player.speed || 0);

        const maxPoisonTicks = Math.max(poisonGhostTimer, poisonSniperTimer);
        if (maxPoisonTicks > 0) {
            baseSpeed *= 3;
        }

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
        if (player.mutatiorbBuffSpeedBoost === true) {
            additionalSpeed += (player.heroType == 10) ? 90 : 60;
        }
        if (player.sweetToothConsumed === true) {
            additionalSpeed += 150;
        }

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

        const iceSpeed = player.calculateSpeedChanges ? player.calculateSpeedChanges(player.speed) : (player.speed || 0);
        let currentIceSpeed = iceSpeed;
        if (baseSpeed === 0 && additionalSpeed > 0) {
            currentIceSpeed = additionalSpeed;
        }

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

                            if (hasTargetSpeed && invuln) {
                                isPlayerSticky = true;
                            }
                        }
                    });
                }
                if (isPlayerSticky) finalMovementSpeed *= 0.8;
            } catch (e) {}
        }

        let dirX = Math.round(currentMouseX - centerX);
        let dirY = Math.round(currentMouseY - centerY);

        if (currentDist > mouseDistFullStrength) {
            dirX *= mouseDistFullStrength / currentDist;
            dirY *= mouseDistFullStrength / currentDist;
        }

        const mouseAngle = Math.atan2(dirY, dirX);
        const mouseDistance = Math.min(mouseDistFullStrength, Math.sqrt(dirX ** 2 + dirY ** 2));

        let distanceMovement = (mouseDistance / mouseDistFullStrength) * finalMovementSpeed;
        if (isShiftPressed || player.shift) {
            distanceMovement *= 0.5;
        }

        if (isDebugVisible) {
            updateDebugUI(baseSpeed, additionalSpeed, finalMovementSpeed, effectiveSlow, isVoid, (zoneFriction === 0), player.voidTime || 0, player.isIced === true, isMagmaxAbilityActive, isNightActive, maxPoisonTicks, mouseDistFullStrength, distanceMovement, currentDist, aura.pullX, aura.pullY, avgPing, PREDICT_TICKS);
        }

        let d_x = 0;
        let d_y = 0;

        const trackedMagnitude = Math.hypot(playerVx, playerVy);
        let prevMoved = [0, 0];
        if (trackedMagnitude > 0.05) {
            prevMoved = [playerVx, playerVy];
        } else if (player.distance_moved_previously) {
            prevMoved = [player.distance_moved_previously[0] || 0, player.distance_moved_previously[1] || 0];
        }

        if (zoneFriction > 0) {
            const frictionFactor = 1 - zoneFriction;

            d_x = distanceMovement * Math.cos(mouseAngle);
            d_y = distanceMovement * Math.sin(mouseAngle);

            let slide_x = prevMoved[0] * frictionFactor;
            let slide_y = prevMoved[1] * frictionFactor;

            d_x += slide_x;
            d_y += slide_y;

            const currentSpeedMagnitude = Math.hypot(d_x, d_y);
            const maxAllowed = Math.max(distanceMovement, currentIceSpeed);
            if (currentSpeedMagnitude > maxAllowed && currentSpeedMagnitude > 0) {
                d_x = (d_x / currentSpeedMagnitude) * maxAllowed;
                d_y = (d_y / currentSpeedMagnitude) * maxAllowed;
            }
        } else {
            const prevMagnitude = Math.hypot(prevMoved[0], prevMoved[1]);

            if (prevMagnitude > 0.05) {
                d_x = (prevMoved[0] / prevMagnitude) * currentIceSpeed;
                d_y = (prevMoved[1] / prevMagnitude) * currentIceSpeed;
            } else {
                d_x = Math.cos(mouseAngle) * currentIceSpeed;
                d_y = Math.sin(mouseAngle) * currentIceSpeed;
            }
        }

        let stepX = (d_x / 32) * timeFix;
        let stepY = (d_y / 32) * timeFix;

        // Интегрируем суммарный импульс аур в текущий тик предикта камеры
        stepX += aura.pullX * timeFix;
        stepY += aura.pullY * timeFix;

        predictedStepsX.push(stepX);
        predictedStepsY.push(stepY);

        // Ограничиваем длину истории согласно PREDICT_TICKS
        while (predictedStepsX.length > PREDICT_TICKS) {
            predictedStepsX.shift();
            predictedStepsY.shift();
        }

        let totalOffsetX = 0;
        let totalOffsetY = 0;
        for (let i = 0; i < predictedStepsX.length; i++) {
            totalOffsetX += predictedStepsX[i];
            totalOffsetY += predictedStepsY[i];
        }

        let finalX = pX + totalOffsetX;
        let finalY = pY + totalOffsetY;

        if (game.area) {
            const radius = player.radius || 15;
            let zonesList = [];
            if (game.area.zones) {
                try {
                    zonesList = typeof game.area.zones.list === 'function' ? game.area.zones.list() : (Array.isArray(game.area.zones) ? game.area.zones : []);
                } catch (e) {}
            }

            if (zonesList.length > 0) {
                const isInsideAnyZone = (x, y) => {
                    for (let i = 0; i < zonesList.length; i++) {
                        const zone = zonesList[i];
                        if (x >= zone.x && x <= zone.x + zone.width &&
                            y >= zone.y && y <= zone.y + zone.height) {
                            return true;
                        }
                    }
                    return false;
                };

                let playerZones = [];
                for (let i = 0; i < zonesList.length; i++) {
                    const zone = zonesList[i];
                    if (pX >= zone.x && pX <= zone.x + zone.width &&
                        pY >= zone.y && pY <= zone.y + zone.height) {
                        playerZones.push(zone);
                    }
                }
                if (playerZones.length === 0) {
                    playerZones.push({ x: 0, y: 0, width: game.area.width || 9999, height: game.area.height || 9999 });
                }

                let currentMinX = Math.min(...playerZones.map(z => z.x));
                let currentMaxX = Math.max(...playerZones.map(z => z.x + z.width));
                let currentMinY = Math.min(...playerZones.map(z => z.y));
                let currentMaxY = Math.max(...playerZones.map(z => z.y + z.height));

                if (totalOffsetX > 0) {
                    if (!isInsideAnyZone(finalX + radius, pY)) finalX = Math.min(finalX, currentMaxX - radius);
                } else if (totalOffsetX < 0) {
                    if (!isInsideAnyZone(finalX - radius, pY)) finalX = Math.max(finalX, currentMinX + radius);
                }

                if (totalOffsetY > 0) {
                    if (!isInsideAnyZone(pX, finalY + radius)) finalY = Math.min(finalY, currentMaxY - radius);
                } else if (totalOffsetY < 0) {
                    if (!isInsideAnyZone(pX, finalY - radius)) finalY = Math.max(finalY, currentMinY + radius);
                }
            } else {
                const maxWidth = game.area.width || 0;
                const maxHeight = game.area.height || 0;
                if (maxWidth > 0) finalX = Math.max(radius, Math.min(maxWidth - radius, finalX));
                if (maxHeight > 0) finalY = Math.max(radius, Math.min(maxHeight - radius, finalY));
            }
        }

        // Экспорт для оверлея
        window.__predictData = {
            x: finalX,
            y: finalY,
            time: performance.now()
        };

        return { x: finalX, y: finalY };
    }

    // Функция обновления дебаг-панели (без console.log)
    function updateDebugUI(base, add, final, slow, voidState, slipperyState, voidTicks, isIced, magmaxActive, nightActive, poisonTicks, maxMouseDist, cursorSpeed, currentDist, pullX, pullY, avgPing, dynamicTicks) {
        const pullMag = Math.hypot(pullX, pullY);
        debugDiv.innerHTML = `
            <b style="color: #fff;">[CAMERA PREDICT DEBUG]</b><br>
            <span style="color: #aaa;">----------------------</span><br>
            Base Speed: <span style="color: #fff;">${base.toFixed(2)}</span><br>
            Add Speed:  <span style="color: #ffcc00;">+${add.toFixed(2)}</span><br>
            Max Speed:  <span style="color: #00ffff; font-weight: bold;">${final.toFixed(2)}</span><br>
            <span style="color: #aaa;">--- CURSOR & DYNAMICS ---</span><br>
            Max Mouse R:<span style="color: #ff99ff;"> ${maxMouseDist.toFixed(0)}px</span><br>
            Real Speed: <span style="color: #ffff00; font-weight: bold;">${cursorSpeed.toFixed(2)}</span><br>
            Mouse Dist: <span style="color: #ff9999;">${currentDist.toFixed(1)}px</span><br>
            <span style="color: #aaa;">--- CONNECTION ---</span><br>
            Avg Ping:   <span style="color: #ffff00;">${avgPing.toFixed(1)} ms</span><br>
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

                currentArea.render = function(ctx, cam) {
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