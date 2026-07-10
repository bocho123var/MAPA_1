// ============================================================
//  js/app.js  -  Dashboard GIS con localStorage
//  Versión Final - Con correcciones de precisión, KML y leyenda
// ============================================================

(function() {
    'use strict';

    // ============================================================
    //  VARIABLES GLOBALES
    // ============================================================
    let map, drawnItems, drawControl;
    let editingPredioId = null;
    let herramientaActiva = null;
    const STORAGE_KEY = 'gis_predios';
    const MAX_FEATURES = 30000;
    let prediosPanelCollapsed = false;
    let selectedPredios = new Set();
    let currentExtractPredioId = null;
    let intersectionLayer = null;
    let statsChartInstance = null;
    let layerLegendControl = null;
    let leyendaVisible = true;

    // ============================================================
    //  LOCALSTORAGE
    // ============================================================
    function getPredios() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.warn('Error leyendo localStorage:', e);
            return [];
        }
    }

    function savePredios(predios) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(predios));
        } catch (e) {
            console.error('Error guardando en localStorage:', e);
            mostrarEstado('❌ Error al guardar datos');
        }
    }

    function addPredio(predio) {
        const predios = getPredios();
        predio.id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        predio.creado = new Date().toISOString();
        predios.push(predio);
        savePredios(predios);
        return predio;
    }

    function updatePredio(id, data) {
        const predios = getPredios();
        const idx = predios.findIndex(p => p.id === id);
        if (idx === -1) return null;
        predios[idx] = { ...predios[idx], ...data, actualizado: new Date().toISOString() };
        savePredios(predios);
        return predios[idx];
    }

    function deletePredio(id) {
        let predios = getPredios();
        predios = predios.filter(p => p.id !== id);
        savePredios(predios);
        selectedPredios.delete(id);
    }

    function clearPredios() {
        savePredios([]);
        selectedPredios.clear();
    }

    // ============================================================
    //  FUNCIONES DE VALIDACIÓN DE GEOMETRÍAS
    // ============================================================
    function cerrarPoligono(coords) {
        if (!coords || coords.length === 0) return coords;
        if (coords.length < 3) return coords;
        const first = coords[0];
        const last = coords[coords.length - 1];
        const tolerancia = 0.0000001;
        const diffX = Math.abs(first[0] - last[0]);
        const diffY = Math.abs(first[1] - last[1]);
        if (diffX > tolerancia || diffY > tolerancia) {
            return [...coords, [first[0], first[1]]];
        }
        return coords;
    }

    function validarGeometria(geo) {
        if (!geo) return null;
        if (geo.type === 'Polygon') {
            if (!geo.coordinates || geo.coordinates.length === 0) return null;
            const coords = geo.coordinates[0];
            if (!coords || coords.length < 3) return null;
            const closed = cerrarPoligono(coords);
            return { type: 'Polygon', coordinates: [closed] };
        }
        if (geo.type === 'LineString') {
            if (!geo.coordinates || geo.coordinates.length < 2) return null;
            return geo;
        }
        if (geo.type === 'Point') {
            if (!geo.coordinates || geo.coordinates.length !== 2) return null;
            return geo;
        }
        if (geo.type === 'MultiPolygon') {
            if (!geo.coordinates || geo.coordinates.length === 0) return null;
            const coords = geo.coordinates[0][0];
            if (!coords || coords.length < 3) return null;
            const closed = cerrarPoligono(coords);
            return { type: 'Polygon', coordinates: [closed] };
        }
        return geo;
    }

    // ============================================================
    //  FUNCIONES DE OPACIDAD
    // ============================================================
    function setLayerOpacity(layer, opacity) {
        if (!layer) return;
        if (typeof layer.setOpacity === 'function') {
            layer.setOpacity(opacity);
            return;
        }
        if (typeof layer.eachLayer === 'function') {
            layer.eachLayer(function(subLayer) {
                if (typeof subLayer.setStyle === 'function') {
                    subLayer.setStyle({ opacity: opacity, fillOpacity: opacity * 0.7 });
                } else if (typeof subLayer.setOpacity === 'function') {
                    subLayer.setOpacity(opacity);
                }
            });
            return;
        }
        if (typeof layer.setStyle === 'function') {
            layer.setStyle({ opacity: opacity, fillOpacity: opacity * 0.7 });
            return;
        }
    }

    // ============================================================
    //  FUNCIONES DE CÁLCULO DE ÁREA
    // ============================================================
    function calcularAreaPoligono(coords) {
        if (!coords || coords.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < coords.length; i++) {
            const j = (i + 1) % coords.length;
            area += coords[i][0] * coords[j][1];
            area -= coords[j][0] * coords[i][1];
        }
        area = Math.abs(area) / 2;
        const latCenter = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        const metersPerDegree = 111320 * Math.cos(latCenter * Math.PI / 180);
        return area * metersPerDegree * metersPerDegree;
    }

    function calcularAreaPrecisa(geojson) {
        try {
            if (geojson.type === 'Polygon') {
                return calcularAreaPoligono(geojson.coordinates[0]);
            }
            return 0;
        } catch (e) {
            return 0;
        }
    }

    // ============================================================
    //  FUNCIÓN DE REDONDEO DE PORCENTAJE
    // ============================================================
    function redondearPorcentaje(valor) {
        return Math.round(valor * 100) / 100;
    }

    // ============================================================
    //  FUNCIONES DE INTERSECCIÓN
    // ============================================================
    function puntoEnPoligono(x, y, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];
            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function puntoEnLinea(point, lineCoords, tolerancia) {
        tolerancia = tolerancia || 0.00001;
        const x = point[0], y = point[1];
        for (let i = 0; i < lineCoords.length - 1; i++) {
            const x1 = lineCoords[i][0], y1 = lineCoords[i][1];
            const x2 = lineCoords[i + 1][0], y2 = lineCoords[i + 1][1];
            const dx = x2 - x1, dy = y2 - y1;
            const len2 = dx * dx + dy * dy;
            let t = ((x - x1) * dx + (y - y1) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const projX = x1 + t * dx;
            const projY = y1 + t * dy;
            const dist = Math.sqrt((x - projX) * (x - projX) + (y - projY) * (y - projY));
            if (dist < tolerancia) return true;
        }
        return false;
    }

    function verificarInterseccion(predioGeo, featureGeo) {
        try {
            const predioValid = validarGeometria(predioGeo);
            const featureValid = validarGeometria(featureGeo);
            if (!predioValid || !featureValid) return false;

            if (predioValid.type === 'Point') {
                const point = predioValid.coordinates;
                if (featureValid.type === 'Polygon') {
                    const polygon = featureValid.coordinates[0].map(c => [c[0], c[1]]);
                    return puntoEnPoligono(point[0], point[1], polygon);
                } else if (featureValid.type === 'LineString') {
                    return puntoEnLinea(point, featureValid.coordinates);
                } else if (featureValid.type === 'Point') {
                    const dist = Math.sqrt(
                        Math.pow(point[0] - featureValid.coordinates[0], 2) +
                        Math.pow(point[1] - featureValid.coordinates[1], 2)
                    );
                    return dist < 0.00001;
                }
                return false;
            }

            if (predioValid.type === 'LineString') {
                const lineCoords = predioValid.coordinates;
                if (featureValid.type === 'Polygon') {
                    const polygon = featureValid.coordinates[0].map(c => [c[0], c[1]]);
                    for (const point of lineCoords) {
                        if (puntoEnPoligono(point[0], point[1], polygon)) return true;
                    }
                    return false;
                } else if (featureValid.type === 'LineString') {
                    for (const point of lineCoords) {
                        if (puntoEnLinea(point, featureValid.coordinates)) return true;
                    }
                    for (const point of featureValid.coordinates) {
                        if (puntoEnLinea(point, lineCoords)) return true;
                    }
                    return false;
                } else if (featureValid.type === 'Point') {
                    return puntoEnLinea(featureValid.coordinates, lineCoords);
                }
                return false;
            }

            if (predioValid.type === 'Polygon') {
                const coords = predioValid.coordinates[0];
                const polygon = coords.map(c => [c[0], c[1]]);
                
                let featureCoords;
                if (featureValid.type === 'Polygon') {
                    featureCoords = featureValid.coordinates[0];
                } else if (featureValid.type === 'Point') {
                    featureCoords = [featureValid.coordinates];
                } else if (featureValid.type === 'LineString') {
                    featureCoords = featureValid.coordinates;
                } else {
                    return false;
                }

                for (const point of featureCoords) {
                    if (puntoEnPoligono(point[0], point[1], polygon)) {
                        return true;
                    }
                }
                
                if (featureValid.type === 'Polygon') {
                    for (const point of polygon) {
                        const featurePolygon = featureValid.coordinates[0].map(c => [c[0], c[1]]);
                        if (puntoEnPoligono(point[0], point[1], featurePolygon)) {
                            return true;
                        }
                    }
                }
                return false;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function obtenerInterseccionPrecisa(predioGeo, featureGeo) {
        try {
            const predioValid = validarGeometria(predioGeo);
            const featureValid = validarGeometria(featureGeo);
            if (!predioValid || !featureValid) {
                return { intersects: false, area: 0, areaPredio: 0, porcentaje: 0 };
            }

            const intersects = verificarInterseccion(predioValid, featureValid);
            
            if (intersects) {
                const areaPredio = calcularAreaPrecisa(predioValid);
                
                let puntosDentro = 0;
                let totalPuntos = 0;
                
                if (predioValid.type === 'Polygon') {
                    const polyCoords = predioValid.coordinates[0];
                    
                    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                    for (const p of polyCoords) {
                        if (p[0] < minX) minX = p[0];
                        if (p[0] > maxX) maxX = p[0];
                        if (p[1] < minY) minY = p[1];
                        if (p[1] > maxY) maxY = p[1];
                    }
                    
                    const muestras = 50;
                    const stepX = (maxX - minX) / muestras;
                    const stepY = (maxY - minY) / muestras;
                    const poly = polyCoords.map(c => [c[0], c[1]]);
                    
                    for (let i = 0; i < muestras; i++) {
                        for (let j = 0; j < muestras; j++) {
                            const x = minX + (i + 0.5) * stepX;
                            const y = minY + (j + 0.5) * stepY;
                            
                            if (puntoEnPoligono(x, y, poly)) {
                                totalPuntos++;
                                
                                let dentroFeature = false;
                                if (featureValid.type === 'Polygon') {
                                    const featurePoly = featureValid.coordinates[0].map(c => [c[0], c[1]]);
                                    dentroFeature = puntoEnPoligono(x, y, featurePoly);
                                } else if (featureValid.type === 'LineString') {
                                    dentroFeature = puntoEnLinea([x, y], featureValid.coordinates);
                                } else if (featureValid.type === 'Point') {
                                    const dist = Math.sqrt(
                                        Math.pow(x - featureValid.coordinates[0], 2) +
                                        Math.pow(y - featureValid.coordinates[1], 2)
                                    );
                                    dentroFeature = dist < 0.00001;
                                }
                                
                                if (dentroFeature) {
                                    puntosDentro++;
                                }
                            }
                        }
                    }
                } else {
                    const areaFeature = calcularAreaPrecisa(featureValid);
                    let area = Math.min(areaFeature, areaPredio) * 0.5;
                    if (areaPredio === 0) area = 0;
                    let porcentaje = 0;
                    if (areaPredio > 0) {
                        porcentaje = redondearPorcentaje(Math.min((area / areaPredio) * 100, 100));
                    }
                    return {
                        intersects: true,
                        area: area,
                        areaPredio: areaPredio,
                        porcentaje: porcentaje
                    };
                }
                
                let porcentaje = 0;
                let areaInterseccion = 0;
                
                if (totalPuntos > 0) {
                    const proporcion = puntosDentro / totalPuntos;
                    porcentaje = redondearPorcentaje(Math.min(proporcion * 100, 100));
                    areaInterseccion = proporcion * areaPredio;
                }
                
                return {
                    intersects: true,
                    area: areaInterseccion,
                    areaPredio: areaPredio,
                    porcentaje: porcentaje
                };
            }
            return { intersects: false, area: 0, areaPredio: 0, porcentaje: 0 };
        } catch (e) {
            console.warn('Error en intersección:', e);
            return { intersects: false, area: 0, areaPredio: 0, porcentaje: 0 };
        }
    }

    // ============================================================
    //  FUNCIONES DE SIMBOLOGÍA CON GRADIENTES
    // ============================================================
    function generarGradiente(colors, steps) {
        const gradient = [];
        const numColors = colors.length;
        for (let i = 0; i < steps; i++) {
            const pos = i / (steps - 1);
            const idx = pos * (numColors - 1);
            const idx1 = Math.floor(idx);
            const idx2 = Math.min(idx1 + 1, numColors - 1);
            const frac = idx - idx1;
            
            const c1 = hexToRgb(colors[idx1]);
            const c2 = hexToRgb(colors[idx2]);
            
            const r = Math.round(c1.r + (c2.r - c1.r) * frac);
            const g = Math.round(c1.g + (c2.g - c1.g) * frac);
            const b = Math.round(c1.b + (c2.b - c1.b) * frac);
            
            gradient.push(`rgb(${r},${g},${b})`);
        }
        return gradient;
    }

    function hexToRgb(hex) {
        let c = hex.replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        return {
            r: parseInt(c.slice(0, 2), 16),
            g: parseInt(c.slice(2, 4), 16),
            b: parseInt(c.slice(4, 6), 16)
        };
    }

    // ============================================================
    //  TOGGLE LEYENDA
    // ============================================================
    function toggleLeyenda() {
        const legendDiv = document.getElementById('layerLegend');
        if (legendDiv) {
            leyendaVisible = legendDiv.style.display !== 'none';
            legendDiv.style.display = leyendaVisible ? 'none' : 'block';
            const btn = document.getElementById('toggleLegendBtn');
            if (btn) {
                btn.innerHTML = leyendaVisible ? '📊 Mostrar Simbología' : '📊 Ocultar Simbología';
            }
            leyendaVisible = !leyendaVisible;
        }
    }

    // ============================================================
    //  MOSTRAR INFORMACIÓN EN EL MAPA
    // ============================================================
    function mostrarInterseccionEnMapa(intersectionGeo, predioId) {
        if (intersectionLayer) {
            map.removeLayer(intersectionLayer);
            intersectionLayer = null;
        }
        if (!intersectionGeo) return;
        try {
            let layer;
            if (intersectionGeo.type === 'Polygon') {
                const coords = intersectionGeo.coordinates[0].map(c => [c[1], c[0]]);
                layer = L.polygon(coords, {
                    color: '#FF0000',
                    weight: 3,
                    opacity: 0.8,
                    fillColor: '#FF0000',
                    fillOpacity: 0.3,
                    dashArray: '5,5'
                });
            } else if (intersectionGeo.type === 'Point') {
                layer = L.circleMarker([intersectionGeo.coordinates[1], intersectionGeo.coordinates[0]], {
                    radius: 10,
                    color: '#FF0000',
                    weight: 3,
                    opacity: 0.8,
                    fillColor: '#FF0000',
                    fillOpacity: 0.5
                });
            }
            if (layer) {
                layer.bindPopup(`<b>🔴 Intersección</b><br>Predio: ${predioId.slice(0,8)}`);
                layer.addTo(map);
                intersectionLayer = layer;
                setTimeout(() => {
                    try {
                        const bounds = layer.getBounds();
                        if (bounds && bounds.isValid()) {
                            map.flyToBounds(bounds, { padding: [50, 50], duration: 1.5 });
                        }
                    } catch(e) {}
                }, 500);
            }
        } catch (e) {
            console.warn('Error mostrando intersección:', e);
        }
    }

    // ============================================================
    //  IR AL POLÍGONO
    // ============================================================
    function irAlPoligono(predioId) {
        const predios = getPredios();
        const predio = predios.find(p => p.id === predioId);
        if (!predio) {
            mostrarEstado('❌ Predio no encontrado');
            return;
        }
        try {
            const geo = JSON.parse(predio.geometry);
            let layerEncontrado = null;
            drawnItems.eachLayer(layer => {
                if (layer._predioId === predioId) {
                    layerEncontrado = layer;
                }
            });
            if (layerEncontrado) {
                const bounds = layerEncontrado.getBounds();
                if (bounds && bounds.isValid()) {
                    map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 18, duration: 1.2 });
                    const originalStyle = layerEncontrado.options;
                    layerEncontrado.setStyle({ color: '#FF0000', weight: 4, fillOpacity: 0.6 });
                    setTimeout(() => {
                        layerEncontrado.setStyle({
                            color: originalStyle.color || '#4CAF50',
                            weight: originalStyle.weight || 2,
                            fillOpacity: originalStyle.fillOpacity || 0.4
                        });
                    }, 3000);
                    mostrarEstado(`📍 Navegando a: ${predio.nombre}`);
                }
            } else {
                if (geo.type === 'Polygon') {
                    const coords = geo.coordinates[0].map(c => [c[1], c[0]]);
                    const tempLayer = L.polygon(coords, {
                        color: '#FF0000',
                        weight: 3,
                        fillColor: '#FF0000',
                        fillOpacity: 0.2
                    });
                    tempLayer.addTo(map);
                    const bounds = tempLayer.getBounds();
                    if (bounds && bounds.isValid()) {
                        map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 18, duration: 1.2 });
                        setTimeout(() => { map.removeLayer(tempLayer); }, 4000);
                        mostrarEstado(`📍 Navegando a: ${predio.nombre}`);
                    }
                } else if (geo.type === 'Point') {
                    const latlng = L.latLng(geo.coordinates[1], geo.coordinates[0]);
                    map.flyTo(latlng, 18, { duration: 1.2 });
                    const marker = L.circleMarker(latlng, {
                        radius: 15,
                        color: '#FF0000',
                        weight: 3,
                        fillColor: '#FF0000',
                        fillOpacity: 0.5
                    }).addTo(map);
                    setTimeout(() => { map.removeLayer(marker); }, 4000);
                    mostrarEstado(`📍 Navegando a: ${predio.nombre}`);
                } else if (geo.type === 'LineString') {
                    const coords = geo.coordinates.map(c => [c[1], c[0]]);
                    const tempLayer = L.polyline(coords, {
                        color: '#FF0000',
                        weight: 4,
                        opacity: 0.8
                    }).addTo(map);
                    const bounds = tempLayer.getBounds();
                    if (bounds && bounds.isValid()) {
                        map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 16, duration: 1.2 });
                    }
                    setTimeout(() => { map.removeLayer(tempLayer); }, 4000);
                    mostrarEstado(`📍 Navegando a: ${predio.nombre}`);
                }
            }
        } catch (e) {
            console.error('Error en irAlPoligono:', e);
            mostrarEstado('❌ Error al navegar al polígono');
        }
    }

    // ============================================================
    //  CAPAS BASE
    // ============================================================
    function agregarCapasBase() {
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        });
        const googleHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
            attribution: '© Google',
            maxZoom: 20,
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
        });
        const esriSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri',
            maxZoom: 19
        });
        const baseLayers = {
            'OpenStreetMap': osm,
            'Google Hybrid': googleHybrid,
            'ESRI Satélite': esriSatellite
        };
        osm.addTo(map);
        L.control.layers(baseLayers, null, { position: 'bottomright' }).addTo(map);
        console.log('✅ Capas base agregadas');
    }

    // ============================================================
    //  INICIALIZACIÓN
    // ============================================================
    document.addEventListener('DOMContentLoaded', async function() {
        try {
            actualizarLoading('Cargando manifiesto...');
            const resp = await fetch('manifest.json');
            if (!resp.ok) throw new Error('No se pudo cargar manifest.json');
            const manifest = await resp.json();
            actualizarLoading('Creando mapa...');
            map = L.map('map', {
                center: manifest.centro || [-34.6037, -58.3816],
                zoom: manifest.zoom || 6,
                minZoom: 4,
                maxZoom: 19,
                zoomControl: true
            });
            agregarCapasBase();
            drawnItems = L.featureGroup().addTo(map);
            actualizarLoading('Cargando capas...');
            await cargarCapas(manifest.capas || []);
            actualizarLoading('Configurando herramientas...');
            configurarDibujo();
            cargarPrediosGuardados();
            configurarUI(manifest);
            configurarPrediosPanel();
            configurarExportacion();
            document.getElementById('loading').classList.add('hidden');
            console.log('✅ Dashboard listo');
            console.log(`📊 ${getPredios().length} predios cargados`);
        } catch (error) {
            console.error('❌ Error:', error);
            document.getElementById('loading').innerHTML = `
                <div style="text-align:center;color:#d32f2f;max-width:400px;">
                    <i class="fas fa-exclamation-triangle" style="font-size:48px;margin-bottom:16px;"></i>
                    <h2>Error al cargar</h2>
                    <p style="color:#666;font-size:14px;margin:10px 0;">${error.message}</p>
                    <button onclick="location.reload()" style="
                        margin-top:16px; padding:10px 32px;
                        background:#4CAF50; color:#fff; border:none;
                        border-radius:6px; cursor:pointer; font-size:16px;
                    ">
                        <i class="fas fa-redo"></i> Reintentar
                    </button>
                </div>
            `;
        }
    });

    function actualizarLoading(mensaje) {
        const el = document.getElementById('loadingStatus');
        if (el) el.textContent = mensaje;
    }

    // ============================================================
    //  CARGAR CAPAS DESDE MANIFEST
    // ============================================================
    async function cargarCapas(capasConfig) {
        const layerList = document.getElementById('layerList');
        layerList.innerHTML = '';
        if (window._capas) {
            Object.values(window._capas).forEach(layer => {
                try { map.removeLayer(layer); } catch(e) {}
            });
        }
        window._capas = {};
        
        const legendControl = L.control({ position: 'bottomleft' });
        legendControl.onAdd = function() {
            const div = L.DomUtil.create('div', 'info legend');
            div.id = 'layerLegend';
            div.style.cssText = `
                background: white;
                padding: 12px 16px;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                max-height: 300px;
                overflow-y: auto;
                min-width: 150px;
                font-size: 12px;
                display: block;
            `;
            div.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <h4 style="margin:0;font-size:13px;color:#333;">📊 Simbología</h4>
                    <button id="toggleLegendBtn" style="
                        background:none;
                        border:none;
                        cursor:pointer;
                        font-size:11px;
                        color:#666;
                        padding:2px 8px;
                        border-radius:4px;
                        hover:background:#f0f0f0;
                    ">Ocultar</button>
                </div>
                <div id="legendContent"></div>
            `;
            return div;
        };
        legendControl.addTo(map);
        layerLegendControl = legendControl;

        // Evento para el botón de toggle de leyenda
        setTimeout(() => {
            const toggleBtn = document.getElementById('toggleLegendBtn');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', toggleLeyenda);
            }
        }, 100);

        for (const cfg of capasConfig) {
            try {
                const item = document.createElement('div');
                item.className = 'layer-item';
                item.dataset.id = cfg.id;
                item.innerHTML = `
                    <span class="layer-color" style="background:${cfg.color || '#3388ff'}"></span>
                    <span class="layer-name">${cfg.nombre}</span>
                    <span class="layer-info">⏳</span>
                    <span class="layer-actions">
                        <button class="layer-btn layer-btn-zoom" data-id="${cfg.id}" title="Ir a la capa">
                            <i class="fas fa-crosshairs"></i>
                        </button>
                        <button class="layer-btn layer-btn-symbol" data-id="${cfg.id}" title="Simbología">
                            <i class="fas fa-palette"></i>
                        </button>
                        <button class="layer-btn layer-btn-toggle ${cfg.visible !== false ? 'active' : ''}" data-id="${cfg.id}" title="Mostrar/Ocultar">
                            <i class="fas fa-eye"></i>
                        </button>
                    </span>
                `;
                layerList.appendChild(item);
                actualizarLoading(`Cargando ${cfg.nombre}...`);
                const resp = await fetch(cfg.archivo);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                let data;
                if (cfg.tipo === 'topojson') {
                    try {
                        const topo = await resp.json();
                        if (!topo.objects || Object.keys(topo.objects).length === 0) {
                            throw new Error('TopoJSON sin objetos');
                        }
                        const objName = cfg.objeto || Object.keys(topo.objects)[0];
                        data = topojson.feature(topo, topo.objects[objName]);
                    } catch (e) {
                        console.warn('Error en TopoJSON, intentando como GeoJSON:', e);
                        const fallbackResp = await fetch(cfg.archivo);
                        data = await fallbackResp.json();
                        if (!data.features) {
                            throw new Error('No es GeoJSON válido');
                        }
                    }
                } else {
                    data = await resp.json();
                    if (!data.features) {
                        throw new Error('El archivo no es un GeoJSON válido');
                    }
                }
                if (data.features && data.features.length > MAX_FEATURES) {
                    console.warn(`⚠️ ${cfg.nombre}: ${data.features.length} features, limitando a ${MAX_FEATURES}`);
                    data.features = data.features.slice(0, MAX_FEATURES);
                }
                const estilo = {
                    color: cfg.color || '#3388ff',
                    weight: cfg.peso || 2,
                    opacity: cfg.opacidad || 0.7,
                    fillColor: cfg.color || '#3388ff',
                    fillOpacity: cfg.opacidad || 0.4
                };
                const layer = L.geoJSON(data, {
                    style: estilo,
                    onEachFeature: (feature, layer) => {
                        if (cfg.popup && cfg.popup.length) {
                            let html = '<div style="min-width:160px;max-height:250px;overflow-y:auto;">';
                            cfg.popup.forEach((field, i) => {
                                const val = feature.properties[field] !== undefined && feature.properties[field] !== null 
                                    ? feature.properties[field] 
                                    : '—';
                                const label = cfg.etiquetas?.[i] || field;
                                html += `<p style="margin:4px 0;"><strong>${label}</strong> ${val}</p>`;
                            });
                            html += '</div>';
                            layer.bindPopup(html);
                        }
                    }
                });
                layer._configId = cfg.id;
                layer._configNombre = cfg.nombre;
                layer._configVisible = cfg.visible !== false;
                layer._configColor = cfg.color || '#3388ff';
                layer._configData = data;
                layer._configOpacity = cfg.opacidad || 0.7;
                layer._configLegend = null;
                setTimeout(() => {
                    try {
                        layer._configBounds = layer.getBounds();
                    } catch (e) {
                        console.warn('No se pudo calcular bounds para:', cfg.nombre);
                    }
                }, 100);
                if (cfg.visible !== false) {
                    layer.addTo(map);
                    setLayerOpacity(layer, cfg.opacidad || 0.7);
                }
                window._capas[cfg.id] = layer;
                const infoSpan = item.querySelector('.layer-info');
                if (infoSpan) {
                    infoSpan.textContent = data.features ? data.features.length : '?';
                }
                const toggleBtn = item.querySelector('.layer-btn-toggle');
                toggleBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleLayer(cfg.id);
                });
                const zoomBtn = item.querySelector('.layer-btn-zoom');
                zoomBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    irACapa(cfg.id);
                });
                const symbolBtn = item.querySelector('.layer-btn-symbol');
                symbolBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    abrirSimbologia(cfg.id);
                });
                console.log(`✅ Capa cargada: ${cfg.nombre} (${data.features?.length || 0} features)`);
            } catch (error) {
                console.warn(`⚠️ Error cargando capa "${cfg.nombre}":`, error);
                const items = layerList.querySelectorAll('.layer-item');
                items.forEach(el => {
                    if (el.dataset.id === cfg.id) {
                        el.style.opacity = '0.5';
                        const info = el.querySelector('.layer-info');
                        if (info) info.textContent = '❌';
                        el.title = error.message || 'Error';
                    }
                });
            }
        }
        actualizarContadorCapas();
    }

    // ============================================================
    //  TOGGLE CAPA
    // ============================================================
    function toggleLayer(id) {
        const layer = window._capas?.[id];
        if (!layer) {
            mostrarEstado('❌ Capa no encontrada');
            return;
        }
        const visible = layer._configVisible !== false;
        const newVisible = !visible;
        if (newVisible) {
            layer.addTo(map);
            const opacity = layer._configOpacity || 0.7;
            setLayerOpacity(layer, opacity);
        } else {
            map.removeLayer(layer);
        }
        layer._configVisible = newVisible;
        document.querySelectorAll('.layer-item').forEach(el => {
            if (el.dataset.id === id) {
                const toggle = el.querySelector('.layer-btn-toggle');
                if (toggle) {
                    toggle.className = `layer-btn layer-btn-toggle ${newVisible ? 'active' : ''}`;
                }
            }
        });
        actualizarContadorCapas();
        actualizarLeyenda();
        mostrarEstado(`${newVisible ? '👁️' : '🚫'} ${layer._configNombre}`);
    }

    // ============================================================
    //  IR A CAPA
    // ============================================================
    function irACapa(id) {
        const layer = window._capas?.[id];
        if (!layer) {
            mostrarEstado('❌ Capa no encontrada');
            return;
        }
        try {
            let bounds = layer._configBounds || layer.getBounds();
            if (!bounds || !bounds.isValid()) {
                mostrarEstado('⏳ Calculando extensión...');
                let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180;
                let count = 0;
                layer.eachLayer(f => {
                    try {
                        const b = f.getBounds ? f.getBounds() : null;
                        if (b && b.isValid()) {
                            latMin = Math.min(latMin, b.getSouth());
                            latMax = Math.max(latMax, b.getNorth());
                            lngMin = Math.min(lngMin, b.getWest());
                            lngMax = Math.max(lngMax, b.getEast());
                            count++;
                        }
                    } catch(e) {}
                });
                if (count === 0) {
                    mostrarEstado('❌ No hay features en esta capa');
                    return;
                }
                bounds = L.latLngBounds([latMin, lngMin], [latMax, lngMax]);
                layer._configBounds = bounds;
            }
            if (!bounds || !bounds.isValid()) {
                mostrarEstado('❌ No se puede obtener ubicación');
                return;
            }
            map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 1.2 });
            const originalOpacity = layer._configOpacity || 0.7;
            setLayerOpacity(layer, 1);
            layer.bringToFront();
            setTimeout(() => {
                setLayerOpacity(layer, originalOpacity);
            }, 3000);
            mostrarEstado(`📍 Navegando a: ${layer._configNombre}`);
            document.querySelectorAll('.layer-item').forEach(el => {
                el.style.background = '';
                el.style.borderLeftColor = 'transparent';
                if (el.dataset.id === id) {
                    el.style.background = '#e3f2fd';
                    el.style.borderLeftColor = '#1976d2';
                    setTimeout(() => {
                        el.style.background = '';
                        el.style.borderLeftColor = 'transparent';
                    }, 3000);
                }
            });
        } catch (error) {
            console.error('Error en irACapa:', error);
            mostrarEstado('❌ Error al navegar a la capa');
        }
    }

    // ============================================================
    //  SIMBOLOGÍA CON GRADIENTES
    // ============================================================
    let currentSymbolLayerId = null;

    function abrirSimbologia(id) {
        const layer = window._capas?.[id];
        if (!layer) {
            mostrarEstado('❌ Capa no encontrada');
            return;
        }
        currentSymbolLayerId = id;
        const modal = document.getElementById('symbolModal');
        const select = document.getElementById('symbolLayerSelect');
        const fieldSelect = document.getElementById('symbolFieldSelect');
        select.innerHTML = '';
        Object.keys(window._capas).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = window._capas[key]._configNombre || key;
            if (key === id) opt.selected = true;
            select.appendChild(opt);
        });
        const data = layer._configData;
        let fields = [];
        if (data && data.features && data.features.length > 0) {
            const props = data.features[0].properties || {};
            fields = Object.keys(props);
        }
        fieldSelect.innerHTML = '<option value="">-- Seleccionar campo --</option>';
        fields.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            fieldSelect.appendChild(opt);
        });
        document.getElementById('symbolPreview').style.display = 'none';
        document.getElementById('symbolPreviewList').innerHTML = '';
        modal.classList.add('active');
        select.onchange = function() {
            const newId = this.value;
            if (newId) {
                abrirSimbologia(newId);
            }
        };
        fieldSelect.onchange = function() {
            const field = this.value;
            if (field && currentSymbolLayerId) {
                const layerData = window._capas[currentSymbolLayerId]?._configData;
                if (layerData && layerData.features) {
                    const values = layerData.features
                        .map(f => f.properties[field])
                        .filter(v => v !== undefined && v !== null);
                    if (values.length > 0) {
                        const isNumeric = values.every(v => typeof v === 'number');
                        const typeSelect = document.getElementById('symbolTypeSelect');
                        typeSelect.value = isNumeric ? 'numerica' : 'categorica';
                        previsualizarSimbologia();
                    }
                }
            }
        };
        document.getElementById('symbolTypeSelect').onchange = previsualizarSimbologia;
        document.getElementById('symbolColors').oninput = previsualizarSimbologia;
        document.getElementById('applySymbols').onclick = function() {
            aplicarSimbologia();
        };
        document.querySelector('.close-symbol-modal').onclick = function() {
            modal.classList.remove('active');
        };
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
        if (fieldSelect.value) {
            previsualizarSimbologia();
        }
    }

    function previsualizarSimbologia() {
        const layer = window._capas?.[currentSymbolLayerId];
        if (!layer) return;
        const field = document.getElementById('symbolFieldSelect').value;
        if (!field) return;
        const data = layer._configData;
        if (!data || !data.features) return;
        const values = data.features
            .map(f => f.properties[field])
            .filter(v => v !== undefined && v !== null);
        if (values.length === 0) return;
        const type = document.getElementById('symbolTypeSelect').value;
        const colorsStr = document.getElementById('symbolColors').value;
        const colors = colorsStr.split(',').map(c => c.trim()).filter(c => c);
        const previewList = document.getElementById('symbolPreviewList');
        previewList.innerHTML = '';
        let categories = [];
        if (type === 'categorica') {
            const unique = [...new Set(values)];
            const gradient = generarGradiente(colors, unique.length);
            categories = unique.map((v, i) => ({
                label: String(v),
                color: gradient[i % gradient.length]
            }));
        } else {
            const sorted = [...values].sort((a, b) => a - b);
            const min = sorted[0];
            const max = sorted[sorted.length - 1];
            const numClasses = Math.min(colors.length, 5);
            const gradient = generarGradiente(colors, numClasses);
            const step = (max - min) / numClasses;
            for (let i = 0; i < numClasses; i++) {
                const low = min + (i * step);
                const high = low + step;
                categories.push({
                    label: `${Math.round(low)} - ${Math.round(high)}`,
                    color: gradient[i % gradient.length]
                });
            }
        }
        categories.forEach(cat => {
            const div = document.createElement('div');
            div.className = 'symbol-preview-item';
            div.innerHTML = `
                <span class="symbol-preview-color" style="background:${cat.color};"></span>
                <span class="symbol-preview-label">${cat.label}</span>
            `;
            previewList.appendChild(div);
        });
        document.getElementById('symbolPreview').style.display = 'block';
    }

    function aplicarSimbologia() {
        const layer = window._capas?.[currentSymbolLayerId];
        if (!layer) {
            mostrarEstado('❌ Capa no encontrada');
            return;
        }
        const field = document.getElementById('symbolFieldSelect').value;
        if (!field) {
            mostrarEstado('❌ Selecciona un campo');
            return;
        }
        const type = document.getElementById('symbolTypeSelect').value;
        const colorsStr = document.getElementById('symbolColors').value;
        const colors = colorsStr.split(',').map(c => c.trim()).filter(c => c);
        const data = layer._configData;
        if (!data || !data.features) {
            mostrarEstado('❌ No hay datos en la capa');
            return;
        }
        const values = data.features
            .map(f => f.properties[field])
            .filter(v => v !== undefined && v !== null);
        if (values.length === 0) {
            mostrarEstado('❌ El campo no tiene valores');
            return;
        }
        let styleFunction;
        let legendData = [];

        if (type === 'categorica') {
            const unique = [...new Set(values)];
            const gradient = generarGradiente(colors, unique.length);
            const colorMap = {};
            unique.forEach((v, i) => {
                colorMap[v] = gradient[i % gradient.length];
            });
            legendData = unique.map((v, i) => ({
                label: String(v),
                color: gradient[i % gradient.length]
            }));
            styleFunction = function(feature) {
                const val = feature.properties[field];
                const color = colorMap[val] || '#888';
                return {
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.5,
                    weight: 2,
                    opacity: 0.8
                };
            };
        } else {
            const sorted = [...values].sort((a, b) => a - b);
            const min = sorted[0];
            const max = sorted[sorted.length - 1];
            const numClasses = Math.min(colors.length, 5);
            const gradient = generarGradiente(colors, numClasses);
            const step = (max - min) / numClasses;
            const classes = [];
            for (let i = 0; i < numClasses; i++) {
                const low = min + (i * step);
                const high = low + step;
                classes.push({
                    min: low,
                    max: high,
                    color: gradient[i % gradient.length]
                });
                legendData.push({
                    label: `${Math.round(low)} - ${Math.round(high)}`,
                    color: gradient[i % gradient.length]
                });
            }
            styleFunction = function(feature) {
                const val = feature.properties[field];
                let color = '#888';
                for (const cls of classes) {
                    if (val >= cls.min && val <= cls.max) {
                        color = cls.color;
                        break;
                    }
                }
                return {
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.5,
                    weight: 2,
                    opacity: 0.8
                };
            };
        }

        layer.eachLayer(function(l) {
            if (l.feature && l.feature.properties) {
                const style = styleFunction(l.feature);
                l.setStyle(style);
            }
        });

        layer._symbolConfig = { field, type, colors, legendData };
        layer._configLegend = legendData;
        
        document.getElementById('symbolModal').classList.remove('active');
        actualizarLeyenda();
        mostrarEstado(`🎨 Simbología aplicada a: ${layer._configNombre}`);
    }

    // ============================================================
    //  ACTUALIZAR LEYENDA
    // ============================================================
    function actualizarLeyenda() {
        const legendDiv = document.getElementById('layerLegend');
        const legendContent = document.getElementById('legendContent');
        if (!legendDiv || !legendContent) return;

        let hasLegend = false;
        let html = '';

        Object.keys(window._capas).forEach(key => {
            const layer = window._capas[key];
            if (layer._configVisible !== false && layer._configLegend && layer._configLegend.length > 0) {
                hasLegend = true;
                html += `<div style="margin:6px 0;font-weight:600;font-size:11px;color:#333;">${layer._configNombre}</div>`;
                layer._configLegend.forEach(item => {
                    html += `<div style="display:flex;align-items:center;margin:3px 0;font-size:11px;">
                        <span style="display:inline-block;width:16px;height:16px;background:${item.color};border:1px solid #ddd;border-radius:3px;margin-right:8px;flex-shrink:0;"></span>
                        <span>${item.label}</span>
                    </div>`;
                });
            }
        });

        if (hasLegend) {
            legendContent.innerHTML = html;
            legendDiv.style.display = 'block';
            const btn = document.getElementById('toggleLegendBtn');
            if (btn) btn.innerHTML = 'Ocultar';
        } else {
            legendDiv.style.display = 'none';
        }
    }

    function actualizarContadorCapas() {
        const visibles = Object.values(window._capas || {}).filter(l => l._configVisible !== false).length;
        document.getElementById('layerStatus').textContent = `📚 ${visibles}`;
    }

    // ============================================================
    //  CONFIGURAR DIBUJO
    // ============================================================
    function configurarDibujo() {
        drawControl = new L.Control.Draw({
            position: 'topleft',
            draw: {
                polygon: {
                    allowIntersection: false,
                    showArea: true,
                    shapeOptions: { color: '#4CAF50', weight: 3, fillColor: '#4CAF50', fillOpacity: 0.3 }
                },
                rectangle: {
                    shapeOptions: { color: '#2196F3', weight: 3, fillColor: '#2196F3', fillOpacity: 0.3 }
                },
                circle: {
                    shapeOptions: { color: '#FF9800', weight: 3, fillColor: '#FF9800', fillOpacity: 0.3 }
                },
                marker: true,
                polyline: {
                    shapeOptions: { color: '#E91E63', weight: 3 }
                }
            },
            edit: { featureGroup: drawnItems, remove: true }
        });
        map.addControl(drawControl);
        map.on(L.Draw.Event.CREATED, onDrawCreated);
        map.on(L.Draw.Event.EDITED, onDrawEdited);
        map.on(L.Draw.Event.DELETED, onDrawDeleted);
        document.querySelectorAll('.btn-draw').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                activarHerramienta(tool);
            });
        });
        map.on('mousemove', (e) => {
            const c = e.latlng;
            document.getElementById('coordStatus').textContent =
                `📍 ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
            document.getElementById('zoomStatus').textContent =
                `🔍 ${map.getZoom()}`;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') desactivarHerramienta();
            if (e.ctrlKey && e.key === 'd') {
                e.preventDefault();
                document.querySelector('.btn-draw[data-tool="polygon"]')?.click();
            }
        });
    }

    function activarHerramienta(tool) {
        if (herramientaActiva === tool) {
            desactivarHerramienta();
            return;
        }
        desactivarHerramienta();
        herramientaActiva = tool;
        const drawOpts = {
            draw: {},
            edit: { featureGroup: drawnItems, remove: true }
        };
        drawOpts.draw[tool] = drawControl.options.draw[tool] || true;
        map.removeControl(drawControl);
        drawControl = new L.Control.Draw(drawOpts);
        map.addControl(drawControl);
        try {
            const cls = tool.charAt(0).toUpperCase() + tool.slice(1);
            const handler = new L.Draw[cls](map, drawControl.options.draw[tool]);
            handler.enable();
        } catch (e) {
            console.warn('Error activando herramienta:', e);
        }
        document.querySelectorAll('.btn-draw').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.btn-draw[data-tool="${tool}"]`);
        if (btn) btn.classList.add('active');
        map.getContainer().style.cursor = 'crosshair';
        mostrarEstado(`✏️ Dibujando ${tool}...`);
    }

    function desactivarHerramienta() {
        herramientaActiva = null;
        try {
            map.removeControl(drawControl);
        } catch(e) {}
        drawControl = new L.Control.Draw({
            position: 'topleft',
            draw: {
                polygon: true, rectangle: true, circle: true, marker: true, polyline: true
            },
            edit: { featureGroup: drawnItems, remove: true }
        });
        map.addControl(drawControl);
        map.getContainer().style.cursor = '';
        document.querySelectorAll('.btn-draw').forEach(b => b.classList.remove('active'));
    }

    // ============================================================
    //  EVENTOS DE DIBUJO
    // ============================================================
    function onDrawCreated(e) {
        const layer = e.layer;
        drawnItems.addLayer(layer);
        const geo = obtenerGeometria(layer);
        const area = calcularArea(layer);
        mostrarModal(layer, geo, area);
        desactivarHerramienta();
        mostrarEstado('✅ Figura creada');
    }

    function onDrawEdited(e) {
        const layers = e.layers;
        layers.eachLayer(layer => {
            if (layer._predioId) {
                const geo = obtenerGeometria(layer);
                const area = calcularArea(layer);
                updatePredio(layer._predioId, { geometry: JSON.stringify(geo), area });
            }
        });
        actualizarListaPredios();
        mostrarEstado('✏️ Predio actualizado');
    }

    function onDrawDeleted(e) {
        const layers = e.layers;
        layers.eachLayer(layer => {
            if (layer._predioId) {
                deletePredio(layer._predioId);
            }
        });
        actualizarListaPredios();
        mostrarEstado('🗑️ Predio eliminado');
    }

    // ============================================================
    //  GEOMETRÍA Y ÁREA
    // ============================================================
    function obtenerGeometria(layer) {
        try {
            if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
                const pts = layer.getLatLngs()[0];
                if (!pts || pts.length < 3) return { type: 'Point', coordinates: [0, 0] };
                const coords = pts.map(p => [p.lng, p.lat]);
                const closedCoords = cerrarPoligono(coords);
                return { type: 'Polygon', coordinates: [closedCoords] };
            }
            if (layer instanceof L.Circle) {
                const pts = circleToPolygon(layer.getLatLng(), layer.getRadius(), 64);
                const closedPts = cerrarPoligono(pts);
                return { type: 'Polygon', coordinates: [closedPts] };
            }
            if (layer instanceof L.Marker) {
                const pos = layer.getLatLng();
                return { type: 'Point', coordinates: [pos.lng, pos.lat] };
            }
            if (layer instanceof L.Polyline) {
                const pts = layer.getLatLngs();
                if (pts.length < 2) return { type: 'Point', coordinates: [0, 0] };
                return { type: 'LineString', coordinates: pts.map(p => [p.lng, p.lat]) };
            }
            return { type: 'Point', coordinates: [0, 0] };
        } catch (e) {
            console.warn('Error obteniendo geometría:', e);
            return { type: 'Point', coordinates: [0, 0] };
        }
    }

    function calcularArea(layer) {
        try {
            if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
                const geo = obtenerGeometria(layer);
                return calcularAreaPrecisa(geo);
            }
            if (layer instanceof L.Circle) {
                return Math.PI * layer.getRadius() ** 2;
            }
            return 0;
        } catch (e) {
            console.warn('Error calculando área:', e);
            return 0;
        }
    }

    function circleToPolygon(center, radius, sides) {
        const R = 6371000;
        const lat = center.lat * Math.PI / 180;
        const lng = center.lng * Math.PI / 180;
        const d = radius / R;
        const pts = [];
        for (let i = 0; i <= sides; i++) {
            const b = i * 2 * Math.PI / sides;
            const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(b));
            const lng2 = lng + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
            pts.push([lng2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
        }
        return pts;
    }

    // ============================================================
    //  MODAL PROPIEDADES
    // ============================================================
    let modalLayer = null;

    function mostrarModal(layer, geometry, area) {
        const modal = document.getElementById('propertyModal');
        const count = getPredios().length;
        document.getElementById('predioNombre').value = `Predio ${count + 1}`;
        document.getElementById('predioArea').value = Math.round(area) || 0;
        document.getElementById('predioPropietario').value = '';
        document.getElementById('predioUso').value = 'residencial';
        document.getElementById('predioColor').value = '#4CAF50';
        document.getElementById('predioNotas').value = '';
        editingPredioId = null;
        modalLayer = layer;
        const saveBtn = document.getElementById('saveProperties');
        const deleteBtn = document.getElementById('deletePredio');
        const closeBtn = document.querySelector('.close-modal');
        const newSave = saveBtn.cloneNode(true);
        const newDelete = deleteBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSave, saveBtn);
        deleteBtn.parentNode.replaceChild(newDelete, deleteBtn);
        newSave.addEventListener('click', guardarPredio);
        newDelete.addEventListener('click', eliminarPredioDesdeModal);
        closeBtn.addEventListener('click', () => modal.classList.remove('active'));
        modal.classList.add('active');
    }

    function guardarPredio() {
        const modal = document.getElementById('propertyModal');
        const data = {
            nombre: document.getElementById('predioNombre').value || 'Sin nombre',
            area: parseFloat(document.getElementById('predioArea').value) || 0,
            propietario: document.getElementById('predioPropietario').value || '',
            uso: document.getElementById('predioUso').value || 'residencial',
            color: document.getElementById('predioColor').value || '#4CAF50',
            notas: document.getElementById('predioNotas').value || '',
            geometry: JSON.stringify(obtenerGeometria(modalLayer))
        };
        if (editingPredioId) {
            updatePredio(editingPredioId, data);
        } else {
            const saved = addPredio(data);
            modalLayer._predioId = saved.id;
            aplicarColor(modalLayer, saved.color);
        }
        actualizarListaPredios();
        modal.classList.remove('active');
        mostrarEstado('✅ Predio guardado');
    }

    function eliminarPredioDesdeModal() {
        if (!editingPredioId) {
            document.getElementById('propertyModal').classList.remove('active');
            return;
        }
        if (confirm('¿Eliminar este predio?')) {
            deletePredio(editingPredioId);
            drawnItems.eachLayer(l => {
                if (l._predioId === editingPredioId) {
                    drawnItems.removeLayer(l);
                }
            });
            actualizarListaPredios();
            document.getElementById('propertyModal').classList.remove('active');
            mostrarEstado('🗑️ Predio eliminado');
        }
    }

    function aplicarColor(layer, color) {
        try {
            if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
                layer.setStyle({ fillColor: color, color: darken(color, 30) });
            } else if (layer instanceof L.Circle) {
                layer.setStyle({ fillColor: color, color: darken(color, 30) });
            } else if (layer instanceof L.Marker) {
                const icon = L.divIcon({
                    className: 'custom-marker',
                    html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                });
                layer.setIcon(icon);
            }
        } catch (e) {
            console.warn('Error aplicando color:', e);
        }
    }

    function darken(hex, amt) {
        try {
            let c = hex.replace('#', '');
            if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
            const r = Math.max(0, parseInt(c.slice(0, 2), 16) - amt);
            const g = Math.max(0, parseInt(c.slice(2, 4), 16) - amt);
            const b = Math.max(0, parseInt(c.slice(4, 6), 16) - amt);
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
        } catch (e) {
            return hex;
        }
    }

    // ============================================================
    //  CARGAR PREDIOS GUARDADOS
    // ============================================================
    function cargarPrediosGuardados() {
        const predios = getPredios();
        predios.forEach(p => {
            try {
                const geo = JSON.parse(p.geometry);
                let layer;
                if (geo.type === 'Polygon') {
                    const pts = geo.coordinates[0].map(c => [c[1], c[0]]);
                    layer = L.polygon(pts, {
                        color: p.color || '#4CAF50',
                        fillColor: p.color || '#4CAF50',
                        fillOpacity: 0.4,
                        weight: 2
                    });
                } else if (geo.type === 'Point') {
                    layer = L.marker([geo.coordinates[1], geo.coordinates[0]]);
                } else if (geo.type === 'LineString') {
                    const pts = geo.coordinates.map(c => [c[1], c[0]]);
                    layer = L.polyline(pts, {
                        color: p.color || '#2196F3',
                        weight: 3
                    });
                }
                if (layer) {
                    layer._predioId = p.id;
                    layer.bindPopup(`
                        <b>${p.nombre || 'Sin nombre'}</b><br>
                        Propietario: ${p.propietario || '—'}<br>
                        Área: ${p.area || 0} m²
                    `);
                    drawnItems.addLayer(layer);
                }
            } catch (e) {
                console.warn('Error cargando predio:', p.id);
            }
        });
        actualizarListaPredios();
    }

    // ============================================================
    //  ACTUALIZAR LISTA DE PREDIOS
    // ============================================================
    function actualizarListaPredios() {
        const predios = getPredios();
        const list = document.getElementById('predioList');
        const count = document.getElementById('predioCount');
        const status = document.getElementById('predioStatus');
        count.textContent = predios.length;
        status.textContent = `📌 ${predios.length}`;
        list.innerHTML = '';
        if (predios.length === 0) {
            list.innerHTML = '<p class="empty">Sin predios. ¡Dibuja uno!</p>';
            actualizarSeleccionStatus();
            return;
        }
        predios.forEach(p => {
            const isSelected = selectedPredios.has(p.id);
            const div = document.createElement('div');
            div.className = `predio-item ${isSelected ? 'selected' : ''}`;
            div.style.borderLeftColor = p.color || '#4CAF50';
            div.dataset.id = p.id;
            div.innerHTML = `
                <input type="checkbox" class="predio-checkbox" ${isSelected ? 'checked' : ''} data-id="${p.id}" title="Seleccionar" />
                <div class="predio-info">
                    <span class="predio-nombre">${p.nombre || 'Sin nombre'}</span>
                    <span class="predio-detalle">${p.propietario || '—'} • ${p.area || 0}m²</span>
                </div>
                <div class="predio-actions">
                    <button class="btn-small btn-goto" data-id="${p.id}" title="Ir al polígono">
                        <i class="fas fa-crosshairs"></i>
                    </button>
                    <button class="btn-small btn-stats" data-id="${p.id}" title="Estadísticas">
                        <i class="fas fa-chart-bar"></i>
                    </button>
                    <button class="btn-small btn-extract" data-id="${p.id}" title="Extraer info">
                        <i class="fas fa-cut"></i>
                    </button>
                    <button class="btn-small btn-kml" data-id="${p.id}" title="Exportar KML">
                        <i class="fas fa-file-alt"></i>
                    </button>
                    <button class="btn-small btn-edit" data-id="${p.id}" title="Editar">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-small btn-delete" data-id="${p.id}" title="Eliminar">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
            list.appendChild(div);
        });
        list.querySelectorAll('.predio-checkbox').forEach(cb => {
            cb.addEventListener('change', function(e) {
                e.stopPropagation();
                const id = this.dataset.id;
                if (this.checked) {
                    selectedPredios.add(id);
                } else {
                    selectedPredios.delete(id);
                }
                actualizarSeleccionStatus();
                const item = this.closest('.predio-item');
                if (item) {
                    item.classList.toggle('selected', this.checked);
                }
            });
        });
        list.querySelectorAll('.btn-goto').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                irAlPoligono(b.dataset.id);
            });
        });
        list.querySelectorAll('.btn-stats').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                ejecutarEstadisticasDesdePredio(b.dataset.id);
            });
        });
        list.querySelectorAll('.btn-extract').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                abrirExtractor(b.dataset.id);
            });
        });
        list.querySelectorAll('.btn-kml').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                exportarKMLPredio(b.dataset.id);
            });
        });
        list.querySelectorAll('.btn-edit').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                editarPredio(b.dataset.id);
            });
        });
        list.querySelectorAll('.btn-delete').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = b.dataset.id;
                if (confirm('¿Eliminar este predio?')) {
                    deletePredio(id);
                    selectedPredios.delete(id);
                    drawnItems.eachLayer(l => {
                        if (l._predioId === id) drawnItems.removeLayer(l);
                    });
                    actualizarListaPredios();
                    actualizarSeleccionStatus();
                    mostrarEstado('🗑️ Predio eliminado');
                }
            });
        });
        list.querySelectorAll('.predio-item').forEach(item => {
            item.addEventListener('click', function(e) {
                if (e.target.closest('.btn-small') || e.target.closest('.predio-checkbox')) return;
                const cb = this.querySelector('.predio-checkbox');
                if (cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            });
        });
        actualizarSeleccionStatus();
    }

    function actualizarSeleccionStatus() {
        const count = selectedPredios.size;
        document.getElementById('selectedStatus').textContent = `✅ ${count}`;
    }

    // ============================================================
    //  EDITAR PREDIO
    // ============================================================
    function editarPredio(id) {
        const predio = getPredios().find(p => p.id === id);
        if (!predio) return;
        let layer = null;
        drawnItems.eachLayer(l => {
            if (l._predioId === id) layer = l;
        });
        if (!layer) return;
        editingPredioId = id;
        modalLayer = layer;
        const modal = document.getElementById('propertyModal');
        document.getElementById('predioNombre').value = predio.nombre || '';
        document.getElementById('predioArea').value = predio.area || 0;
        document.getElementById('predioPropietario').value = predio.propietario || '';
        document.getElementById('predioUso').value = predio.uso || 'residencial';
        document.getElementById('predioColor').value = predio.color || '#4CAF50';
        document.getElementById('predioNotas').value = predio.notas || '';
        const saveBtn = document.getElementById('saveProperties');
        const deleteBtn = document.getElementById('deletePredio');
        const closeBtn = document.querySelector('.close-modal');
        const newSave = saveBtn.cloneNode(true);
        const newDelete = deleteBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSave, saveBtn);
        deleteBtn.parentNode.replaceChild(newDelete, deleteBtn);
        newSave.addEventListener('click', guardarPredio);
        newDelete.addEventListener('click', eliminarPredioDesdeModal);
        closeBtn.addEventListener('click', () => modal.classList.remove('active'));
        modal.classList.add('active');
    }

    // ============================================================
    //  EXPORTAR KML DE UN PREDIO (CORREGIDO)
    // ============================================================
    function exportarKMLPredio(predioId) {
        const predios = getPredios();
        const predio = predios.find(p => p.id === predioId);
        if (!predio) {
            mostrarEstado('❌ Predio no encontrado');
            return;
        }
        try {
            const geo = JSON.parse(predio.geometry);
            let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${predio.nombre || 'Predio'}</name>
<description>Exportado ${new Date().toLocaleString()}</description>
`;
            if (geo.type === 'Polygon') {
                // CORREGIDO: orden correcto longitud, latitud
                const coords = geo.coordinates[0].map(c => `${c[0]},${c[1]},0`).join(' ');
                kml += `
<Placemark>
  <name>${predio.nombre || 'Sin nombre'}</name>
  <description>
    Propietario: ${predio.propietario || '—'}
    Área: ${predio.area || 0} m²
    Uso: ${predio.uso || '—'}
    ${predio.notas ? 'Notas: ' + predio.notas : ''}
  </description>
  <styleUrl>#predioStyle</styleUrl>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>`;
            } else if (geo.type === 'Point') {
                // CORREGIDO: orden correcto longitud, latitud
                kml += `
<Placemark>
  <name>${predio.nombre || 'Punto'}</name>
  <description>
    Coordenadas: ${geo.coordinates[1]}, ${geo.coordinates[0]}
    Propietario: ${predio.propietario || '—'}
    Uso: ${predio.uso || '—'}
    ${predio.notas ? 'Notas: ' + predio.notas : ''}
  </description>
  <Point><coordinates>${geo.coordinates[0]},${geo.coordinates[1]},0</coordinates></Point>
</Placemark>`;
            } else if (geo.type === 'LineString') {
                // CORREGIDO: orden correcto longitud, latitud
                const coords = geo.coordinates.map(c => `${c[0]},${c[1]},0`).join(' ');
                kml += `
<Placemark>
  <name>${predio.nombre || 'Línea'}</name>
  <description>
    Vértices: ${geo.coordinates.length}
    Propietario: ${predio.propietario || '—'}
    ${predio.notas ? 'Notas: ' + predio.notas : ''}
  </description>
  <LineString><coordinates>${coords}</coordinates></LineString>
</Placemark>`;
            }
            kml += `
  <Style id="predioStyle">
    <LineStyle>
      <color>ff${predio.color ? predio.color.replace('#', '') : '4CAF50'}</color>
      <width>3</width>
    </LineStyle>
    <PolyStyle>
      <color>7f${predio.color ? predio.color.replace('#', '') : '4CAF50'}</color>
    </PolyStyle>
  </Style>
</Document>
</kml>`;
            const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
            saveAs(blob, `${predio.nombre || 'predio'}_${new Date().toISOString().slice(0,10)}.kml`);
            mostrarEstado(`📤 KML exportado: ${predio.nombre}`);
        } catch (error) {
            console.error('Error exportando KML:', error);
            mostrarEstado('❌ Error al exportar KML');
        }
    }

    // ============================================================
    //  ESTADÍSTICAS DESDE PREDIO
    // ============================================================
    function ejecutarEstadisticasDesdePredio(predioId) {
        const predios = getPredios();
        const predio = predios.find(p => p.id === predioId);
        if (!predio) {
            mostrarEstado('❌ Predio no encontrado');
            return;
        }

        let predioGeo;
        try {
            predioGeo = JSON.parse(predio.geometry);
        } catch (e) {
            mostrarEstado('❌ Error al leer geometría del predio');
            return;
        }

        const predioValid = validarGeometria(predioGeo);
        if (!predioValid) {
            mostrarEstado('❌ Geometría del predio no válida');
            return;
        }

        const capasDisponibles = Object.keys(window._capas);
        if (capasDisponibles.length === 0) {
            mostrarEstado('❌ No hay capas base disponibles');
            return;
        }

        const selectedLayers = capasDisponibles.map(id => ({
            id: id,
            layer: window._capas[id]
        }));

        const results = [];
        let totalExtracted = 0;
        let totalAreaIntersection = 0;

        selectedLayers.forEach(({ id, layer }) => {
            const data = layer._configData;
            if (!data || !data.features) return;

            data.features.forEach(feature => {
                try {
                    const featureValid = validarGeometria(feature.geometry);
                    if (!featureValid) return;

                    const interseccion = obtenerInterseccionPrecisa(predioValid, featureValid);
                    
                    if (interseccion.intersects) {
                        const row = {
                            'Capa': layer._configNombre,
                            'Predio': predio.nombre,
                            'Geometría Predio': predioValid.type,
                            'Área Predio (m²)': Math.round(interseccion.areaPredio),
                            'Área Intersección (m²)': Math.round(interseccion.area),
                            'Cobertura (%)': redondearPorcentaje(interseccion.porcentaje)
                        };
                        
                        if (predioValid.type === 'Point') {
                            row['Coordenadas'] = `${predioValid.coordinates[1].toFixed(6)}, ${predioValid.coordinates[0].toFixed(6)}`;
                        }
                        if (predioValid.type === 'LineString') {
                            row['Vértices'] = predioValid.coordinates.length;
                        }
                        
                        if (feature.properties) {
                            Object.keys(feature.properties).forEach(key => {
                                const value = feature.properties[key];
                                row[key] = value !== undefined && value !== null ? value : '—';
                            });
                        }
                        
                        results.push(row);
                        totalExtracted++;
                        totalAreaIntersection += interseccion.area;
                    }
                } catch (e) {
                    // Silenciar errores individuales
                }
            });
        });

        if (results.length === 0) {
            mostrarEstado('ℹ️ No se encontraron datos que intersecten con el predio');
            return;
        }

        window._extractData = results;
        window._extractPredioNombre = predio.nombre;

        mostrarEstado(`📊 ${results.length} elementos extraídos - Abriendo estadísticas...`);

        setTimeout(() => {
            abrirEstadisticasDesdeDatos();
        }, 500);
    }

    // ============================================================
    //  ABRIR ESTADÍSTICAS DESDE DATOS GUARDADOS
    // ============================================================
    function abrirEstadisticasDesdeDatos() {
        const modal = document.getElementById('statsModal');
        const layerSelect = document.getElementById('statsLayerSelect');
        const fieldXSelect = document.getElementById('statsFieldX');
        const fieldYSelect = document.getElementById('statsFieldY');
        const chartTypeSelect = document.getElementById('statsChartType');
        
        layerSelect.innerHTML = '<option value="">Seleccionar capa</option>';
        fieldXSelect.innerHTML = '<option value="">Seleccionar campo</option>';
        
        const extractData = window._extractData || [];
        if (extractData.length === 0) {
            mostrarEstado('⚠️ No hay datos de extracción.');
            return;
        }
        
        const capas = [...new Set(extractData.map(row => row['Capa']))];
        capas.forEach(capa => {
            const opt = document.createElement('option');
            opt.value = capa;
            opt.textContent = capa;
            layerSelect.appendChild(opt);
        });
        
        const camposFijos = ['Capa', 'Predio', 'Geometría Predio', 'Coordenadas', 'Vértices', 'Área Predio (m²)', 'Área Intersección (m²)', 'Cobertura (%)'];
        
        function actualizarCamposXCapa() {
            const capaSeleccionada = layerSelect.value;
            const filteredData = extractData.filter(row => row['Capa'] === capaSeleccionada);
            
            fieldXSelect.innerHTML = '<option value="">Seleccionar campo</option>';
            
            if (filteredData.length > 0) {
                const campos = Object.keys(filteredData[0] || {});
                const camposDisponiblesCapa = campos.filter(f => !camposFijos.includes(f));
                camposDisponiblesCapa.forEach(field => {
                    const opt = document.createElement('option');
                    opt.value = field;
                    opt.textContent = field;
                    fieldXSelect.appendChild(opt);
                });
                if (fieldXSelect.options.length > 1) {
                    fieldXSelect.value = fieldXSelect.options[1].value;
                }
            }
            
            generarGrafico();
        }
        
        layerSelect.onchange = actualizarCamposXCapa;
        
        if (capas.length > 0) {
            layerSelect.value = capas[0];
            setTimeout(actualizarCamposXCapa, 100);
        }
        
        chartTypeSelect.onchange = function() {
            generarGrafico();
        };
        
        fieldXSelect.onchange = function() {
            generarGrafico();
        };
        
        fieldYSelect.onchange = function() {
            generarGrafico();
        };
        
        modal.classList.add('active');
        
        document.querySelector('.close-stats-modal').onclick = function() {
            modal.classList.remove('active');
            if (statsChartInstance) {
                statsChartInstance.destroy();
                statsChartInstance = null;
            }
        };
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
                if (statsChartInstance) {
                    statsChartInstance.destroy();
                    statsChartInstance = null;
                }
            }
        });
    }

    // ============================================================
    //  GENERAR GRÁFICO
    // ============================================================
    function generarGrafico() {
        const layerSelect = document.getElementById('statsLayerSelect');
        const fieldXSelect = document.getElementById('statsFieldX');
        const fieldYSelect = document.getElementById('statsFieldY');
        const chartTypeSelect = document.getElementById('statsChartType');
        
        const capa = layerSelect.value;
        const fieldX = fieldXSelect.value;
        const fieldY = fieldYSelect.value || 'Cobertura (%)';
        const chartType = chartTypeSelect.value || 'bar';
        
        if (!capa || !fieldX) {
            return;
        }
        
        const statsData = window._extractData || [];
        if (statsData.length === 0) {
            mostrarEstado('⚠️ No hay datos para generar el gráfico');
            return;
        }
        
        const filteredData = statsData.filter(row => row['Capa'] === capa);
        
        if (filteredData.length === 0) {
            mostrarEstado('⚠️ No hay datos para la capa seleccionada');
            return;
        }
        
        const grouped = {};
        filteredData.forEach(row => {
            let key = row[fieldX];
            if (key === undefined || key === null) key = 'N/A';
            const value = parseFloat(row[fieldY]) || 0;
            if (!grouped[key]) grouped[key] = 0;
            grouped[key] += value;
        });
        
        const labels = Object.keys(grouped);
        const values = Object.values(grouped);
        
        if (labels.length === 0) {
            mostrarEstado('⚠️ No hay datos para graficar');
            return;
        }
        
        const colors = [
            '#4CAF50', '#2196F3', '#FF9800', '#E91E63', 
            '#9C27B0', '#00BCD4', '#FF5722', '#795548',
            '#607D8B', '#8BC34A', '#FFC107', '#673AB7',
            '#F44336', '#3F51B5', '#009688', '#FF6F00'
        ];
        
        const canvas = document.getElementById('statsChart');
        const container = document.getElementById('statsChartContainer');
        container.style.display = 'block';
        
        if (statsChartInstance) {
            statsChartInstance.destroy();
            statsChartInstance = null;
        }
        
        let datasets = [];
        let backgroundColor = colors.slice(0, labels.length);
        
        if (chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea') {
            datasets = [{
                data: values,
                backgroundColor: backgroundColor,
                borderColor: '#fff',
                borderWidth: 2
            }];
        } else {
            datasets = [{
                label: fieldY,
                data: values,
                backgroundColor: backgroundColor.slice(0, values.length),
                borderColor: '#333',
                borderWidth: 1,
                borderRadius: 4
            }];
        }
        
        const ctx = canvas.getContext('2d');
        statsChartInstance = new Chart(ctx, {
            type: chartType,
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: chartType === 'pie' || chartType === 'doughnut' ? 'right' : 'top',
                        labels: {
                            font: { size: 10 },
                            boxWidth: 12,
                            padding: 8
                        }
                    },
                    title: {
                        display: true,
                        text: `Distribución de ${fieldY} por ${fieldX} (${capa})`,
                        font: { size: 13, weight: 'bold' }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.label || '';
                                let value = context.parsed || context.raw;
                                if (typeof value === 'number') {
                                    return `${label}: ${value.toFixed(2)}%`;
                                }
                                return `${label}: ${value}`;
                            }
                        }
                    }
                },
                scales: chartType === 'pie' || chartType === 'doughnut' || chartType === 'polarArea' ? undefined : {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return value + '%';
                            },
                            font: { size: 9 }
                        }
                    },
                    x: {
                        ticks: {
                            font: { size: 9 },
                            maxRotation: 45,
                            minRotation: 0
                        }
                    }
                }
            }
        });
        
        const tableContainer = document.getElementById('statsDataTable');
        const tableContent = document.getElementById('statsTableContent');
        tableContainer.style.display = 'block';
        
        let tableHtml = '<table style="width:100%;border-collapse:collapse;font-size:11px;">';
        tableHtml += '<tr style="background:#e9ecef;font-weight:600;">';
        tableHtml += `<th style="padding:4px 8px;text-align:left;">${fieldX}</th>`;
        tableHtml += `<th style="padding:4px 8px;text-align:right;">${fieldY}</th>`;
        tableHtml += '<th style="padding:4px 8px;text-align:right;">% del total</th>';
        tableHtml += '</tr>';
        
        const total = values.reduce((a, b) => a + b, 0);
        labels.forEach((label, i) => {
            const pct = total > 0 ? (values[i] / total) * 100 : 0;
            tableHtml += `<tr style="border-bottom:1px solid #eee;">`;
            tableHtml += `<td style="padding:3px 8px;">${label}</td>`;
            tableHtml += `<td style="padding:3px 8px;text-align:right;">${values[i].toFixed(2)}%</td>`;
            tableHtml += `<td style="padding:3px 8px;text-align:right;">${pct.toFixed(1)}%</td>`;
            tableHtml += '</tr>';
        });
        tableHtml += `<tr style="background:#f5f5f5;font-weight:600;">`;
        tableHtml += `<td style="padding:4px 8px;">TOTAL</td>`;
        tableHtml += `<td style="padding:4px 8px;text-align:right;">${total.toFixed(2)}%</td>`;
        tableHtml += `<td style="padding:4px 8px;text-align:right;">100%</td>`;
        tableHtml += '</tr>';
        tableHtml += '</table>';
        tableContent.innerHTML = tableHtml;
    }

    // ============================================================
    //  EXTRACTOR DE INFORMACIÓN
    // ============================================================
    function abrirExtractor(predioId) {
        const predios = getPredios();
        const predio = predios.find(p => p.id === predioId);
        if (!predio) {
            mostrarEstado('❌ Predio no encontrado');
            return;
        }
        currentExtractPredioId = predioId;
        const modal = document.getElementById('extractModal');
        document.getElementById('extractPredioInfo').textContent = 
            `${predio.nombre} (ID: ${predioId.slice(0,8)}) - Área: ${predio.area || 0} m²`;
        const layerContainer = document.getElementById('extractLayerList');
        layerContainer.innerHTML = '';
        const capasDisponibles = Object.keys(window._capas);
        if (capasDisponibles.length === 0) {
            layerContainer.innerHTML = '<p style="color:#999;font-size:13px;">No hay capas base disponibles</p>';
        } else {
            capasDisponibles.forEach(key => {
                const layer = window._capas[key];
                const div = document.createElement('div');
                div.className = 'extract-layer-item';
                div.innerHTML = `
                    <input type="checkbox" class="extract-layer-cb" data-id="${key}" checked />
                    <span class="layer-color-dot" style="background:${layer._configColor || '#3388ff'}"></span>
                    <label>${layer._configNombre}</label>
                    <span style="font-size:10px;color:#999;margin-left:auto;">${layer._configData?.features?.length || 0}</span>
                `;
                layerContainer.appendChild(div);
            });
        }
        const fieldsContainer = document.getElementById('extractFieldsList');
        fieldsContainer.innerHTML = '';
        const allFields = new Set();
        capasDisponibles.forEach(key => {
            const layer = window._capas[key];
            const data = layer._configData;
            if (data && data.features && data.features.length > 0) {
                const props = data.features[0].properties || {};
                Object.keys(props).forEach(f => allFields.add(f));
            }
        });
        if (allFields.size === 0) {
            fieldsContainer.innerHTML = '<span style="color:#999;font-size:13px;">No hay campos disponibles</span>';
        } else {
            allFields.forEach(field => {
                const div = document.createElement('div');
                div.className = 'extract-field-item';
                div.innerHTML = `
                    <input type="checkbox" class="extract-field-cb" value="${field}" checked />
                    <span>${field}</span>
                `;
                fieldsContainer.appendChild(div);
            });
        }
        document.getElementById('extractResult').style.display = 'none';
        document.getElementById('extractResultContent').innerHTML = '';
        if (intersectionLayer) {
            map.removeLayer(intersectionLayer);
            intersectionLayer = null;
        }
        modal.classList.add('active');
        document.getElementById('executeExtract').onclick = function() {
            ejecutarExtraccion(predioId);
        };
        document.querySelector('.close-extract-modal').onclick = function() {
            modal.classList.remove('active');
            if (intersectionLayer) {
                map.removeLayer(intersectionLayer);
                intersectionLayer = null;
            }
        };
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
                if (intersectionLayer) {
                    map.removeLayer(intersectionLayer);
                    intersectionLayer = null;
                }
            }
        });
    }

    function ejecutarExtraccion(predioId) {
        const predios = getPredios();
        const predio = predios.find(p => p.id === predioId);
        if (!predio) {
            mostrarEstado('❌ Predio no encontrado');
            return;
        }
        let predioGeo;
        try {
            predioGeo = JSON.parse(predio.geometry);
        } catch (e) {
            mostrarEstado('❌ Error al leer geometría del predio');
            return;
        }
        const predioValid = validarGeometria(predioGeo);
        if (!predioValid) {
            mostrarEstado('❌ Geometría del predio no válida');
            return;
        }
        const layerCbs = document.querySelectorAll('.extract-layer-cb:checked');
        const selectedLayers = [];
        layerCbs.forEach(cb => {
            const id = cb.dataset.id;
            const layer = window._capas[id];
            if (layer) selectedLayers.push({ id, layer });
        });
        if (selectedLayers.length === 0) {
            mostrarEstado('❌ Selecciona al menos una capa');
            return;
        }
        const fieldCbs = document.querySelectorAll('.extract-field-cb:checked');
        const selectedFields = [];
        fieldCbs.forEach(cb => {
            selectedFields.push(cb.value);
        });
        if (selectedFields.length === 0) {
            mostrarEstado('❌ Selecciona al menos un campo');
            return;
        }
        const results = [];
        let totalExtracted = 0;
        let totalAreaIntersection = 0;
        selectedLayers.forEach(({ id, layer }) => {
            const data = layer._configData;
            if (!data || !data.features) return;
            data.features.forEach(feature => {
                try {
                    const featureValid = validarGeometria(feature.geometry);
                    if (!featureValid) return;
                    const interseccion = obtenerInterseccionPrecisa(predioValid, featureValid);
                    if (interseccion.intersects) {
                        const row = {
                            'Capa': layer._configNombre,
                            'Predio': predio.nombre,
                            'Geometría Predio': predioValid.type,
                            'Área Predio (m²)': Math.round(interseccion.areaPredio),
                            'Área Intersección (m²)': Math.round(interseccion.area),
                            'Cobertura (%)': redondearPorcentaje(interseccion.porcentaje)
                        };
                        if (predioValid.type === 'Point') {
                            row['Coordenadas'] = `${predioValid.coordinates[1].toFixed(6)}, ${predioValid.coordinates[0].toFixed(6)}`;
                        }
                        if (predioValid.type === 'LineString') {
                            row['Vértices'] = predioValid.coordinates.length;
                        }
                        selectedFields.forEach(field => {
                            const value = feature.properties[field];
                            row[field] = value !== undefined && value !== null ? value : '—';
                        });
                        results.push(row);
                        totalExtracted++;
                        totalAreaIntersection += interseccion.area;
                    }
                } catch (e) {
                    // Silenciar errores individuales
                }
            });
        });
        if (results.length === 0) {
            mostrarEstado('ℹ️ No se encontraron datos que intersecten con el predio');
            document.getElementById('extractResult').style.display = 'block';
            document.getElementById('extractResultContent').innerHTML = `
                <div style="color:#999;text-align:center;padding:20px;">
                    <i class="fas fa-info-circle" style="font-size:24px;"></i>
                    <p style="margin-top:10px;">No se encontraron elementos de las capas base dentro de este predio.</p>
                    <p style="font-size:11px;margin-top:5px;">Verifica que el predio intersecte con las capas seleccionadas.</p>
                    <p style="font-size:11px;color:#666;">Área del predio: ${Math.round(calcularAreaPrecisa(predioValid))} m²</p>
                </div>
            `;
            return;
        }
        window._extractData = results;
        document.getElementById('extractResult').style.display = 'block';
        let resultHtml = `
            <div style="font-weight:600;margin-bottom:8px;">✅ ${results.length} elementos intersectan con el predio</div>
            <div style="font-size:12px;color:#666;margin-bottom:8px;">
                Área del predio: ${Math.round(calcularAreaPrecisa(predioValid))} m² | 
                Área total de intersección: ${Math.round(totalAreaIntersection)} m² | 
                Cobertura promedio: ${redondearPorcentaje((totalAreaIntersection / calcularAreaPrecisa(predioValid)) * 100)}%
            </div>
            <div style="max-height:200px;overflow-y:auto;">`;
        results.slice(0, 20).forEach((row, idx) => {
            resultHtml += `<div class="extract-result-row">`;
            const keys = Object.keys(row);
            keys.forEach(key => {
                resultHtml += `<span><strong>${key}:</strong> ${row[key]}</span>`;
            });
            resultHtml += `</div>`;
        });
        if (results.length > 20) {
            resultHtml += `<div style="color:#999;font-size:12px;padding:4px;">... y ${results.length - 20} más</div>`;
        }
        resultHtml += `</div>`;
        document.getElementById('extractResultContent').innerHTML = resultHtml;
        exportExtractToExcel(results, predio.nombre);
        mostrarEstado(`📊 ${results.length} elementos extraídos del predio (${Math.round(totalAreaIntersection)} m² intersectan)`);
    }

    function exportExtractToExcel(data, predioNombre) {
        try {
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(data);
            const colWidths = [];
            const headers = Object.keys(data[0] || {});
            headers.forEach((key, idx) => {
                let maxLen = key.length;
                data.forEach(row => {
                    const val = String(row[key] || '');
                    if (val.length > maxLen) maxLen = val.length;
                });
                colWidths.push({ wch: Math.min(Math.max(maxLen + 2, 12), 40) });
            });
            ws['!cols'] = colWidths;
            XLSX.utils.book_append_sheet(wb, ws, 'Extracción');
            const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            const blob = new Blob([wbout], { type: 'application/octet-stream' });
            const fileName = `extraccion_${predioNombre}_${new Date().toISOString().slice(0,10)}.xlsx`;
            saveAs(blob, fileName);
        } catch (error) {
            console.error('Error exportando Excel:', error);
            mostrarEstado('❌ Error al exportar Excel');
        }
    }

    // ============================================================
    //  CONFIGURAR EXPORTACIÓN
    // ============================================================
    function configurarExportacion() {
        document.getElementById('exportSelected').addEventListener('click', function() {
            if (selectedPredios.size === 0) {
                mostrarEstado('❌ No hay predios seleccionados');
                return;
            }
            exportarSeleccionados();
        });
        document.getElementById('exportExcel').addEventListener('click', function() {
            exportarExcelCompleto();
        });
    }

    function exportarSeleccionados() {
        const predios = getPredios();
        const selected = predios.filter(p => selectedPredios.has(p.id));
        if (selected.length === 0) {
            mostrarEstado('❌ No hay predios seleccionados');
            return;
        }
        const features = selected.map(p => {
            try {
                const geo = JSON.parse(p.geometry);
                const props = { ...p };
                delete props.id;
                delete props.geometry;
                delete props.creado;
                delete props.actualizado;
                return { type: 'Feature', id: p.id, geometry: geo, properties: props };
            } catch (e) {
                return null;
            }
        }).filter(f => f !== null);
        const fc = { type: 'FeatureCollection', features };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
        saveAs(blob, `seleccion_${new Date().toISOString().slice(0,10)}.geojson`);
        mostrarEstado(`📤 ${selected.length} predios exportados`);
    }

    function exportarExcelCompleto() {
        const predios = getPredios();
        if (predios.length === 0) {
            mostrarEstado('❌ No hay predios para exportar');
            return;
        }
        try {
            const data = predios.map(p => {
                const row = {
                    'Nombre': p.nombre || 'Sin nombre',
                    'Área (m²)': p.area || 0,
                    'Propietario': p.propietario || '',
                    'Uso': p.uso || '',
                    'Color': p.color || '',
                    'Notas': p.notas || '',
                    'Creado': p.creado ? new Date(p.creado).toLocaleString() : '',
                    'Actualizado': p.actualizado ? new Date(p.actualizado).toLocaleString() : ''
                };
                try {
                    const geo = JSON.parse(p.geometry);
                    row['Geometría'] = JSON.stringify(geo);
                    row['Tipo Geometría'] = geo.type || 'Desconocido';
                    if (geo.type === 'Polygon') {
                        row['Vértices'] = geo.coordinates[0].length;
                    }
                    if (geo.type === 'Point') {
                        row['Coordenadas'] = `${geo.coordinates[1].toFixed(6)}, ${geo.coordinates[0].toFixed(6)}`;
                    }
                    if (geo.type === 'LineString') {
                        row['Vértices'] = geo.coordinates.length;
                    }
                } catch (e) {
                    row['Geometría'] = 'Error';
                }
                return row;
            });
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(data);
            const colWidths = [
                { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 14 },
                { wch: 10 }, { wch: 30 }, { wch: 20 }, { wch: 20 },
                { wch: 40 }, { wch: 15 }, { wch: 12 }, { wch: 25 }
            ];
            ws['!cols'] = colWidths;
            XLSX.utils.book_append_sheet(wb, ws, 'Predios');
            const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            const blob = new Blob([wbout], { type: 'application/octet-stream' });
            saveAs(blob, `predios_${new Date().toISOString().slice(0,10)}.xlsx`);
            mostrarEstado(`📤 ${predios.length} predios exportados a Excel`);
        } catch (error) {
            console.error('Error exportando Excel:', error);
            mostrarEstado('❌ Error al exportar Excel');
        }
    }

    // ============================================================
    //  EXPORTAR KML TODOS (CORREGIDO)
    // ============================================================
    function exportarKMLTodos() {
        const predios = getPredios();
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Predios</name>
<description>Exportado ${new Date().toLocaleString()}</description>
`;
        predios.forEach(p => {
            try {
                const geo = JSON.parse(p.geometry);
                if (geo.type === 'Polygon') {
                    const coords = geo.coordinates[0].map(c => `${c[0]},${c[1]},0`).join(' ');
                    kml += `
<Placemark>
  <name>${p.nombre || 'Sin nombre'}</name>
  <description>Propietario: ${p.propietario || '—'}</description>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>`;
                } else if (geo.type === 'Point') {
                    kml += `
<Placemark>
  <name>${p.nombre || 'Punto'}</name>
  <description>Coordenadas: ${geo.coordinates[1]}, ${geo.coordinates[0]}</description>
  <Point><coordinates>${geo.coordinates[0]},${geo.coordinates[1]},0</coordinates></Point>
</Placemark>`;
                } else if (geo.type === 'LineString') {
                    const coords = geo.coordinates.map(c => `${c[0]},${c[1]},0`).join(' ');
                    kml += `
<Placemark>
  <name>${p.nombre || 'Línea'}</name>
  <description>Vértices: ${geo.coordinates.length}</description>
  <LineString><coordinates>${coords}</coordinates></LineString>
</Placemark>`;
                }
            } catch(e) {}
        });
        kml += `</Document></kml>`;
        const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
        saveAs(blob, `predios_${new Date().toISOString().slice(0,10)}.kml`);
        mostrarEstado(`📤 ${predios.length} predios exportados a KML`);
    }

    // ============================================================
    //  PANEL DE PREDIOS
    // ============================================================
    function configurarPrediosPanel() {
        const panel = document.getElementById('prediosPanel');
        const toggleBtn = document.getElementById('togglePrediosPanel');
        const header = panel.querySelector('.predios-header');
        document.getElementById('selectAllPredios').addEventListener('click', function(e) {
            e.stopPropagation();
            const predios = getPredios();
            predios.forEach(p => selectedPredios.add(p.id));
            actualizarListaPredios();
            mostrarEstado(`✅ ${predios.length} predios seleccionados`);
        });
        document.getElementById('deselectAllPredios').addEventListener('click', function(e) {
            e.stopPropagation();
            selectedPredios.clear();
            actualizarListaPredios();
            mostrarEstado('🔓 Selección eliminada');
        });
        function togglePanel() {
            prediosPanelCollapsed = !prediosPanelCollapsed;
            panel.classList.toggle('collapsed', prediosPanelCollapsed);
            const icon = toggleBtn.querySelector('i');
            icon.className = prediosPanelCollapsed ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
            setTimeout(() => map.invalidateSize(), 350);
        }
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePanel();
        });
        header.addEventListener('click', togglePanel);
    }

    // ============================================================
    //  UI
    // ============================================================
    function configurarUI(manifest) {
        const toggleBtn = document.getElementById('toggleSidebar');
        const sidebar = document.getElementById('sidebar');
        toggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            icon.className = sidebar.classList.contains('collapsed') ?
                'fas fa-chevron-right' : 'fas fa-chevron-left';
            setTimeout(() => map.invalidateSize(), 350);
        });
        const mobileBtn = document.createElement('button');
        mobileBtn.id = 'mobileToggle';
        mobileBtn.innerHTML = '<i class="fas fa-bars"></i>';
        document.body.prepend(mobileBtn);
        mobileBtn.addEventListener('click', () => {
            sidebar.classList.toggle('mobile-open');
        });
        document.getElementById('exportGeoJSON').addEventListener('click', function() {
            exportarTodos();
        });
        document.getElementById('exportKML').addEventListener('click', function() {
            exportarKMLTodos();
        });
        document.getElementById('clearAll').addEventListener('click', () => {
            if (confirm('¿Eliminar TODOS los predios?')) {
                clearPredios();
                drawnItems.clearLayers();
                actualizarListaPredios();
                mostrarEstado('🗑️ Todos los predios eliminados');
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.getElementById('propertyModal').classList.remove('active');
                document.getElementById('symbolModal').classList.remove('active');
                document.getElementById('extractModal').classList.remove('active');
                document.getElementById('statsModal').classList.remove('active');
                if (intersectionLayer) {
                    map.removeLayer(intersectionLayer);
                    intersectionLayer = null;
                }
                if (statsChartInstance) {
                    statsChartInstance.destroy();
                    statsChartInstance = null;
                }
            }
        });
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                    if (modal.id === 'extractModal' && intersectionLayer) {
                        map.removeLayer(intersectionLayer);
                        intersectionLayer = null;
                    }
                    if (modal.id === 'statsModal' && statsChartInstance) {
                        statsChartInstance.destroy();
                        statsChartInstance = null;
                    }
                }
            });
        });
        console.log(`📋 Manifiesto: ${manifest.nombre} v${manifest.version}`);
    }

    // ============================================================
    //  EXPORTAR TODOS
    // ============================================================
    function exportarTodos() {
        const predios = getPredios();
        const features = predios.map(p => {
            try {
                const geo = JSON.parse(p.geometry);
                const props = { ...p };
                delete props.id;
                delete props.geometry;
                delete props.creado;
                delete props.actualizado;
                return { type: 'Feature', id: p.id, geometry: geo, properties: props };
            } catch (e) {
                return null;
            }
        }).filter(f => f !== null);
        const fc = { type: 'FeatureCollection', features };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
        saveAs(blob, `predios_${new Date().toISOString().slice(0,10)}.geojson`);
        mostrarEstado(`📤 ${predios.length} predios exportados`);
    }

    // ============================================================
    //  UTILIDADES
    // ============================================================
    function mostrarEstado(msg) {
        const bar = document.getElementById('statusBar');
        let el = document.getElementById('tempStatus');
        if (!el) {
            el = document.createElement('span');
            el.id = 'tempStatus';
            bar.prepend(el);
        }
        el.textContent = msg;
        el.style.color = '#4CAF50';
        clearTimeout(el._timeout);
        el._timeout = setTimeout(() => {
            el.textContent = '';
        }, 5000);
    }

    // Exponer para debugging
    window.__map = map;
    window.__drawn = drawnItems;
    window.irACapa = irACapa;
    window.toggleLayer = toggleLayer;
    window.selectedPredios = selectedPredios;

})();
