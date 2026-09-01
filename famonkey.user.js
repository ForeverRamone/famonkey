// ==UserScript==
// @name         FA-Monkey — Plex / Radarr / Sonarr en FilmAffinity
// @namespace    famonkey
// @version      1.6.0
// @description  Marca sobre cada póster de FilmAffinity si la película o serie ya está en tu Plex, y envía a Radarr o Sonarr con un clic las que faltan.
// @author       ForeverRamone
// @match        https://www.filmaffinity.com/*
// @updateURL    https://raw.githubusercontent.com/ForeverRamone/famonkey/main/famonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/ForeverRamone/famonkey/main/famonkey.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_deleteValue, GM_addStyle, GM_registerMenuCommand */

(function () {
    'use strict';

    /* ================================================================== *
     * 1. Configuración y almacenamiento
     * ================================================================== */

    const CFG_KEY  = 'famonkey.config';
    const MAP_KEY  = 'famonkey.map';    // faId  -> coincidencia TMDB
    const META_KEY = 'famonkey.meta';   // faId  -> datos leídos de la ficha
    const TVDB_KEY = 'famonkey.tvdb';   // tmdb  -> tvdb (solo series)
    const IDX_KEY  = 'famonkey.index';  // índices de Plex / Radarr / Sonarr

    const DEFAULTS = {
        tmdbKey: '',

        plexUrl: '',
        plexToken: '',

        radarrUrl: '',
        radarrKey: '',
        radarrProfileId: null,
        radarrRoot: '',
        radarrMinAvail: 'released',
        radarrSearch: true,

        sonarrUrl: '',
        sonarrKey: '',
        sonarrProfileId: null,
        sonarrRoot: '',
        sonarrMonitor: 'all',
        sonarrSearch: true,

        indexTtlHours: 6,
        concurrency: 6
    };

    function readJSON(key, fallback) {
        try {
            const raw = GM_getValue(key, null);
            if (raw === null || raw === undefined) return fallback;
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            return fallback;
        }
    }
    function writeJSON(key, value) {
        GM_setValue(key, JSON.stringify(value));
    }

    let CFG = Object.assign({}, DEFAULTS, readJSON(CFG_KEY, {}));

    const store = {
        map:  readJSON(MAP_KEY,  {}),
        meta: readJSON(META_KEY, {}),
        tvdb: readJSON(TVDB_KEY, {})
    };

    let flushTimer = null;
    function flushSoon() {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(function () {
            writeJSON(MAP_KEY,  store.map);
            writeJSON(META_KEY, store.meta);
            writeJSON(TVDB_KEY, store.tvdb);
        }, 1500);
    }

    /* ================================================================== *
     * 2. Utilidades
     * ================================================================== */

    function base(url) {
        return String(url || '').trim().replace(/\/+$/, '');
    }

    function norm(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // Tampermonkey tiene @connect * para que cada uno pueda apuntar a las
    // direcciones de sus servicios sin editar la cabecera del script. El
    // control de verdad se hace aquí: solo se sale hacia TMDB, hacia la propia
    // web y hacia los servicios configurados, de modo que el token de Plex y
    // las API keys no pueden acabar en un host ajeno.
    function hostOf(url) {
        try {
            return new URL(String(url), location.href).hostname.toLowerCase();
        } catch (e) {
            return null;
        }
    }

    // Hosts que el panel de ajustes está probando y que todavía no se han
    // guardado en la configuración.
    const EXTRA_HOSTS = [];
    function allowHost(url) {
        const h = hostOf(url);
        if (h && EXTRA_HOSTS.indexOf(h) === -1) EXTRA_HOSTS.push(h);
    }

    function allowedHosts() {
        const list = [location.hostname.toLowerCase(), 'api.themoviedb.org', 'image.tmdb.org'];
        ['plexUrl', 'radarrUrl', 'sonarrUrl'].forEach(function (k) {
            const h = hostOf(CFG[k]);
            if (h) list.push(h);
        });
        return list.concat(EXTRA_HOSTS);
    }

    function isAllowedHost(host) {
        if (!host) return false;
        if (allowedHosts().indexOf(host) !== -1) return true;
        // La propia web, con o sin www: la ficha se descarga del dominio base.
        const partes = location.hostname.toLowerCase().split('.');
        const dominio = partes.slice(-2).join('.');
        return host === dominio || host.slice(-(dominio.length + 1)) === '.' + dominio;
    }

    function gmFetch(opts) {
        return new Promise(function (resolve, reject) {
            const destino = hostOf(opts.url);
            if (!isAllowedHost(destino)) {
                return reject(new Error('Destino no permitido: ' + (destino || opts.url)));
            }
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: opts.body,
                timeout: opts.timeout || 30000,
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) return resolve(r);
                    let detail = '';
                    try {
                        const j = JSON.parse(r.responseText);
                        detail = j.message || (Array.isArray(j) && j[0] && j[0].errorMessage) || '';
                    } catch (e) { /* respuesta no JSON */ }
                    reject(new Error('HTTP ' + r.status + (detail ? ': ' + detail : '')));
                },
                onerror:   function () { reject(new Error('No se pudo conectar')); },
                ontimeout: function () { reject(new Error('Tiempo de espera agotado')); }
            });
        });
    }

    async function gmJSON(opts) {
        const r = await gmFetch(opts);
        try {
            return JSON.parse(r.responseText);
        } catch (e) {
            throw new Error('La respuesta no es JSON válido');
        }
    }

    function makeQueue(limit) {
        let active = 0;
        const pending = [];
        function next() {
            if (active >= limit || pending.length === 0) return;
            const job = pending.shift();
            active++;
            Promise.resolve()
                .then(job.fn)
                .then(job.resolve, job.reject)
                .then(function () { active--; next(); });
        }
        return function (fn) {
            return new Promise(function (resolve, reject) {
                pending.push({ fn: fn, resolve: resolve, reject: reject });
                next();
            });
        };
    }

    const queue = makeQueue(CFG.concurrency || 3);

    /* ================================================================== *
     * 3. TMDB
     * ================================================================== */

    const TMDB = 'https://api.themoviedb.org/3';

    function tmdbUrl(path, params) {
        const q = new URLSearchParams(Object.assign({ api_key: CFG.tmdbKey }, params || {}));
        return TMDB + path + '?' + q.toString();
    }

    function tmdbItem(kind, r) {
        const date = kind === 'movie' ? r.release_date : r.first_air_date;
        return {
            kind: kind,
            id: r.id,
            title:    kind === 'movie' ? r.title          : r.name,
            original: kind === 'movie' ? r.original_title  : r.original_name,
            year: date ? parseInt(date.slice(0, 4), 10) || null : null,
            popularity: r.popularity || 0,
            paises: r.origin_country || [],
            poster: r.poster_path || null,
            overview: r.overview || ''
        };
    }

    // Una misma consulta se repite mucho en una sola página: el póster y el
    // título llevan a la misma película, y las temporadas de una serie comparten
    // nombre. Se guarda la promesa, no el resultado, así dos búsquedas idénticas
    // lanzadas a la vez viajan en una sola petición.
    const CACHE_BUSQUEDA = new Map();

    // Cada ficha puntúa y ordena sus candidatos por separado, así que se
    // reparten copias en vez del mismo objeto.
    function copiarItems(items) {
        return items.map(function (o) { return Object.assign({}, o); });
    }

    async function tmdbSearch(kind, query, year) {
        if (!query) return [];
        const clave = kind + '|' + norm(query) + '|' + (year || '');
        const guardada = CACHE_BUSQUEDA.get(clave);
        if (guardada) return copiarItems(await guardada);

        const params = { query: query, language: 'es-ES', include_adult: 'false' };
        if (year) params[kind === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = String(year);
        const pendiente = gmJSON({ url: tmdbUrl('/search/' + kind, params) })
            .then(function (data) {
                return (data.results || []).slice(0, 10).map(function (r) { return tmdbItem(kind, r); });
            });
        CACHE_BUSQUEDA.set(clave, pendiente);
        // Un fallo no se queda guardado: la próxima vez se vuelve a intentar.
        pendiente.catch(function () { CACHE_BUSQUEDA.delete(clave); });
        return copiarItems(await pendiente);
    }

    const CACHE_DIRECTORES = new Map();

    async function tmdbDirectores(item) {
        const clave = item.kind + ':' + item.id;
        if (CACHE_DIRECTORES.has(clave)) return CACHE_DIRECTORES.get(clave);
        const data = await gmJSON({ url: tmdbUrl('/' + item.kind + '/' + item.id + '/credits', {}) });
        const nombres = (data.crew || [])
            .filter(function (c) { return c.job === 'Director'; })
            .map(function (c) { return c.name; });
        CACHE_DIRECTORES.set(clave, nombres);
        return nombres;
    }

    async function tmdbPorId(kind, id) {
        const data = await gmJSON({ url: tmdbUrl('/' + kind + '/' + id, { language: 'es-ES' }) });
        return tmdbItem(kind, data);
    }

    async function tmdbTvdbId(tmdbId) {
        if (Object.prototype.hasOwnProperty.call(store.tvdb, tmdbId)) return store.tvdb[tmdbId];
        const data = await gmJSON({ url: tmdbUrl('/tv/' + tmdbId + '/external_ids', {}) });
        store.tvdb[tmdbId] = data.tvdb_id || null;
        flushSoon();
        return store.tvdb[tmdbId];
    }

    /* ================================================================== *
     * 4. Lectura del DOM de FilmAffinity
     * ================================================================== */

    const RE_FILM_ID = /\/film(\d+)\.html/;
    const APOS = "'";

    function idFromHref(href) {
        const m = RE_FILM_ID.exec(String(href || ''));
        return m ? m[1] : null;
    }

    function isFichaPage() {
        return RE_FILM_ID.test(location.pathname) && !!document.querySelector('h1#main-title');
    }

    // FilmAffinity marca el tipo en el propio título: (Serie de TV), (Miniserie de TV),
    // (TV) para telefilmes y (C) para cortometrajes.
    function detectType(text) {
        const t = String(text || '');
        if (/\((?:serie de tv|miniserie de tv|tv series|tv miniseries)\)/i.test(t)) return 'tv';
        if (/\(c\)/i.test(t)) return 'short';
        if (/\(tv\)/i.test(t)) return 'tvmovie';
        return 'movie';
    }

    function cleanTitle(text) {
        return String(text || '')
            .replace(/\((?:serie de tv|miniserie de tv|tv series|tv miniseries|tv|c|s)\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // El nombre del fichero del póster es el título ORIGINAL convertido a slug.
    // Ej.: "Cementerio" -> mezarlik, "Matrix" -> the_matrix
    function slugFromImg(img) {
        if (!img) return '';
        const sources = [
            img.getAttribute('src') || '',
            img.getAttribute('data-src') || '',
            img.getAttribute('data-srcset') || '',
            img.getAttribute('srcset') || ''
        ].join(' ');
        const m = sources.match(/pics\.filmaffinity\.com\/([^\s"]+?)-\d+-[a-z]+\.jpg/i);
        return m ? m[1] : '';
    }

    function slugTitles(slug) {
        if (!slug) return [];
        const plain = slug.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        const out = [plain];
        // "tyler perry s beauty in black" -> el mismo con apóstrofo en el posesivo
        const apos = plain.replace(/\b(\w+) s\b/gi, '$1' + APOS + 's');
        if (apos !== plain) out.push(apos);
        return out;
    }

    // FilmAffinity abre una ficha por temporada: "Euphoria T3", "The White Lotus 3",
    // y en el título original el marcador es "S3". Sonarr, en cambio, tiene una
    // sola ficha por serie con las temporadas dentro, así que para encontrarla
    // hay que quitar el marcador y quedarse con el número.
    const RE_TEMPORADA = [
        /\s*[-\u2013:]?\s*(?:temporada|season)\s+(\d{1,2})\s*$/i,
        /\s+[TS]\s?(\d{1,2})\s*$/i,
        /\s+(\d{1,2})\s*$/
    ];

    function quitarTemporada(titulo) {
        const t = String(titulo || '').replace(/\s+/g, ' ').trim();
        for (const re of RE_TEMPORADA) {
            const m = re.exec(t);
            if (m) {
                const base = t.slice(0, m.index).trim();
                if (base) return { titulo: base, temporada: parseInt(m[1], 10) };
            }
        }
        return { titulo: t, temporada: null };
    }

    // La bandera del país está en la ruta de su imagen: /imgs/countries2/US.png
    function paisDe(nodo) {
        const img = nodo ? nodo.querySelector('img.nflag') : null;
        const m = img ? /\/countries2\/([A-Z]{2})\./.exec(img.getAttribute('src') || '') : null;
        return m ? m[1] : '';
    }

    function pickText(el) {
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    function extractFromCard(card) {
        const img = card.querySelector('.mc-poster img, img');
        const titleEl = card.querySelector('.mc-title a') || card.querySelector('.mc-title');
        const yearEl = card.querySelector('.mc-year');
        const rawTitle = pickText(titleEl) || (img ? img.getAttribute('alt') || '' : '');
        const typeHint = rawTitle + ' ' + (img ? img.getAttribute('alt') || '' : '');
        return {
            faId: card.getAttribute('data-movie-id'),
            raw: rawTitle,
            title: cleanTitle(rawTitle),
            type: detectType(typeHint),
            year: yearEl ? parseInt(pickText(yearEl), 10) || null : null,
            slug: slugFromImg(img),
            pais: paisDe(card)
        };
    }

    function extractFromAnchor(a) {
        const img = a.querySelector('img');
        const raw = (a.getAttribute('title') || (img && img.getAttribute('alt')) || pickText(a) || '').trim();
        return {
            faId: idFromHref(a.getAttribute('href')),
            raw: raw,
            title: cleanTitle(raw),
            type: detectType(raw),
            year: null,
            slug: slugFromImg(img)
        };
    }

    // Lectura rica: solo disponible en la ficha de la película.
    function readFicha(doc, faId) {
        const nameEl = doc.querySelector('h1#main-title span[itemprop="name"]');
        const typeEl = doc.querySelector('h1#main-title .movie-type .type');
        const ogTitle = doc.querySelector('meta[property="og:title"]');
        const ogText = ogTitle ? ogTitle.getAttribute('content') || '' : '';

        let original = '', year = null, director = '';
        const dl = doc.querySelector('dl.movie-info');
        if (dl) {
            const dts = dl.querySelectorAll('dt');
            for (let i = 0; i < dts.length; i++) {
                const dt = dts[i];
                const dd = dt.nextElementSibling;
                if (!dd || dd.tagName !== 'DD') continue;
                const label = norm(dt.textContent);
                if (label.indexOf('titulo original') === 0) {
                    const copy = dd.cloneNode(true);
                    copy.querySelectorAll('span, i, ul').forEach(function (n) { n.remove(); });
                    original = pickText(copy);
                } else if (label === 'ano') {
                    year = parseInt(pickText(dd), 10) || null;
                } else if (label.indexOf('direccion') === 0) {
                    director = pickText(dd.querySelector('a')) || '';
                }
            }
        }

        if (!year) {
            const m = ogText.match(/\((\d{4})\)\s*$/);
            if (m) year = parseInt(m[1], 10);
        }

        const typeText = pickText(typeEl);
        let type;
        if (/serie/i.test(typeText)) type = 'tv';
        else if (/corto/i.test(typeText)) type = 'short';
        else if (/^tv$/i.test(typeText)) type = 'tvmovie';
        else type = detectType(ogText);

        return {
            faId: faId,
            raw: ogText || pickText(nameEl),
            title: pickText(nameEl) || cleanTitle(ogText),
            original: original || '',
            type: type,
            year: year,
            director: director,
            pais: paisDe(dl || doc.body)
        };
    }

    async function fetchFicha(faId) {
        try {
            const r = await gmFetch({ url: 'https://www.filmaffinity.com/es/film' + faId + '.html' });
            const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
            const data = readFicha(doc, faId);
            return (data && (data.original || data.year)) ? data : null;
        } catch (e) {
            return null;
        }
    }

    /* ================================================================== *
     * 5. Resolución FilmAffinity -> TMDB
     * ================================================================== */

    function kindsFor(type) {
        if (type === 'tv') return ['tv'];
        if (type === 'tvmovie') return ['movie', 'tv'];
        return ['movie'];   // películas y cortometrajes
    }

    function normalizarSerie(meta) {
        if (meta.type !== 'tv') return meta;

        const porTitulo  = quitarTemporada(meta.title);
        const original   = meta.original || (meta.slug ? slugTitles(meta.slug)[0] : '');
        const porOriginal = quitarTemporada(original);
        const temporada  = porTitulo.temporada || porOriginal.temporada || null;

        // Algunas temporadas no llevan número sino nombre: "True Detective:
        // Noche polar" es la cuarta de "True Detective". Lo que va delante de
        // los dos puntos vale como candidato de reserva.
        const variantes = [];
        const corte = porTitulo.titulo.lastIndexOf(':');
        if (corte > 0) {
            const prefijo = porTitulo.titulo.slice(0, corte).trim();
            if (prefijo && norm(prefijo) !== norm(porTitulo.titulo)) variantes.push(prefijo);
        }

        return Object.assign({}, meta, {
            title: porTitulo.titulo,
            original: porOriginal.titulo,
            slug: '',                     // ya aprovechado, y traía el marcador
            season: temporada,
            variantes: variantes,
            // Sin recortar. Se consulta antes que nada, por si la serie se
            // llama así de verdad y el número no era una temporada.
            literal: temporada ? meta.title : '',
            // El año de la ficha es el de esa temporada, no el del estreno de la
            // serie. Solo coincide en la primera, así que en las demás estorba.
            year: (temporada && temporada > 1) ? null : meta.year
        });
    }

    function scoreCandidates(entries, meta) {
        const nOriginal = norm(meta.original || (meta.slug ? slugTitles(meta.slug)[0] : ''));
        const nTitle = norm(meta.title);
        const nLiteral = norm(meta.literal);
        const variantes = (meta.variantes || []).map(norm);
        const list = entries.map(function (e) {
            const r = e.item;
            const no = norm(r.original);
            const nt = norm(r.title);
            let s = 0;

            // Cada título se compara con el suyo: el original con el original y
            // el traducido con el traducido. Que el título traducido de un
            // candidato coincida con nuestro título original es casualidad
            // habitual entre homónimas, así que cuenta poco.
            if (nLiteral && (nt === nLiteral || no === nLiteral)) {
                s += 6;
            } else {
                if (nOriginal && no === nOriginal) s += 6;
                else if (nOriginal && no && (no.indexOf(nOriginal) === 0 || nOriginal.indexOf(no) === 0)) s += 2;

                if (nTitle && nt === nTitle) s += 5;
                else if (variantes.length && (variantes.indexOf(nt) !== -1 || variantes.indexOf(no) !== -1)) s += 4;

                if (nOriginal && no !== nOriginal && nt === nOriginal) s += 2;   // cruzado
                if (nTitle && nt !== nTitle && no === nTitle) s += 2;            // cruzado
            }

            if (e.hits > 1) s += 3;   // aparece en varias búsquedas distintas

            if (meta.year && r.year) {
                const d = Math.abs(meta.year - r.year);
                if (d === 0) s += 4;
                else if (d === 1) s += 1;
                // Se resta poco: el año de TMDB no siempre es de fiar. "Under the
                // Skin" de Glazer, de 2013, figura allí como de 2020.
                else if (meta.type !== 'tv') s -= 2;
            }

            // El país desempata series homónimas de distintos orígenes.
            if (meta.pais && r.paises && r.paises.indexOf(meta.pais) !== -1) s += 3;

            s += Math.min(r.popularity, 40) / 40;   // desempate suave

            // ¿Coincide de verdad algún título, o solo se le parece? Sin una
            // coincidencia exacta no se da nada por bueno: es lo que llevaba a
            // emparejar "Genesis" con "Genesis: The Fall of Eden".
            // Cuentan como exactas todas las formas legítimas del título: el
            // literal sin recortar, el traducido, el original y el prefijo de
            // las temporadas con nombre. Lo que no cuenta es parecerse.
            const exacto = (nLiteral && (nt === nLiteral || no === nLiteral)) ||
                           (nTitle && (nt === nTitle || no === nTitle)) ||
                           (nOriginal && (no === nOriginal || nt === nOriginal)) ||
                           (variantes.length && (variantes.indexOf(nt) !== -1 || variantes.indexOf(no) !== -1));
            return { item: r, score: s, exacto: !!exacto };
        });
        list.sort(function (a, b) { return b.score - a.score; });
        return list;
    }

    function isConfident(scored) {
        if (!scored.length) return false;
        if (scored[0].score < 5) return false;
        if (!scored[0].exacto) return false;
        if (scored.length === 1) return true;
        return (scored[0].score - scored[1].score) >= 3;
    }

    function topItems(scored) {
        return scored.slice(0, 8).map(function (x) { return x.item; });
    }

    async function attemptMatch(meta, seed) {
        const queries = [];
        function addQuery(q) {
            const clean = String(q || '').trim();
            if (!clean) return;
            if (!queries.some(function (x) { return norm(x) === norm(clean); })) queries.push(clean);
        }
        addQuery(meta.literal);
        addQuery(meta.original);
        slugTitles(meta.slug).forEach(addQuery);
        addQuery(meta.title);
        (meta.variantes || []).forEach(addQuery);

        const pool = seed || new Map();
        let scored = scoreCandidates(Array.from(pool.values()), meta);

        async function consultar(kind, q, anio) {
            const results = await tmdbSearch(kind, q, anio);
            for (const r of results) {
                const key = r.kind + ':' + r.id;
                const prev = pool.get(key);
                // Se cuenta en cuántos títulos DISTINTOS aparece cada candidato.
                // Repetir la misma consulta filtrando por año no corrobora nada:
                // es la misma búsqueda, y contarla dos veces premiaba a la
                // película equivocada justo por cuadrar el año.
                if (prev) {
                    prev.terms.add(q);
                    prev.hits = prev.terms.size;
                } else {
                    pool.set(key, { item: r, terms: new Set([q]), hits: 1 });
                }
            }
            return scoreCandidates(Array.from(pool.values()), meta);
        }

        for (const kind of kindsFor(meta.type)) {
            for (const q of queries) {
                // Primero sin filtrar por año: filtrar deja fuera la película
                // buena cuando TMDB la tiene mal fechada, y entonces gana por
                // incomparecencia cualquier homónima que sí cuadre.
                scored = await consultar(kind, q, null);
                if (isConfident(scored)) {
                    return { match: scored[0].item, candidates: topItems(scored), pool: pool };
                }
                // Con el año se rescatan las que quedan sepultadas por
                // popularidad más allá de los diez primeros resultados.
                if (meta.year) {
                    scored = await consultar(kind, q, meta.year);
                    if (isConfident(scored)) {
                        return { match: scored[0].item, candidates: topItems(scored), pool: pool };
                    }
                }
            }
        }

        return { match: null, candidates: topItems(scored), pool: pool };
    }

    // Cuando el título no basta, el director decide. Ocurre con las homónimas:
    // "Under the Skin" son más de veinte películas en TMDB, y solo una la dirige
    // Jonathan Glazer. Solo se consulta si hace falta, y como mucho tres veces.
    async function desempatarPorDirector(candidatos, meta) {
        if (!meta.director || !candidatos || candidatos.length < 2) return null;
        const objetivo = norm(meta.director);
        if (!objetivo) return null;

        for (const item of candidatos.slice(0, 3)) {
            if (item.kind !== 'movie') continue;   // en series FilmAffinity da el creador
            let directores;
            try {
                directores = await tmdbDirectores(item);
            } catch (e) {
                continue;
            }
            const coincide = directores.some(function (d) { return norm(d) === objetivo; });
            if (coincide) return item;
        }
        return null;
    }

    async function resolveMatch(metaCruda) {
        // Se normaliza siempre lo último que se sepa del título: los datos de la
        // ficha pisan a los de la tarjeta y volverían a traer el "T3" y el año
        // de la temporada si se normalizara antes de mezclarlos.
        const meta = normalizarSerie(metaCruda);
        const cached = store.map[metaCruda.faId];
        if (cached) {
            if (cached.none) return { match: null, candidates: [], ignored: true, meta: meta };
            return {
                match: { kind: cached.k, id: cached.i, title: cached.t || meta.title, year: cached.y || meta.year },
                cached: true,
                meta: meta
            };
        }

        let full = normalizarSerie(Object.assign({}, metaCruda, store.meta[metaCruda.faId] || {}));
        let out = await attemptMatch(full);

        // Sin coincidencia clara: la ficha aporta título original, año y dirección.
        if (!out.match && !store.meta[metaCruda.faId]) {
            const extra = await fetchFicha(metaCruda.faId);
            if (extra) {
                store.meta[metaCruda.faId] = extra;
                flushSoon();
                full = normalizarSerie(Object.assign({}, metaCruda, extra));

                const pool = out.pool || new Map();
                const rescored = scoreCandidates(Array.from(pool.values()), full);
                if (isConfident(rescored)) {
                    out = { match: rescored[0].item, candidates: topItems(rescored), pool: pool };
                } else {
                    out = await attemptMatch(full, pool);
                }
            }
        }

        // Última carta: si el título deja empate, el director lo rompe.
        if (!out.match && full.director) {
            const elegido = await desempatarPorDirector(out.candidates || [], full);
            if (elegido) out = { match: elegido, candidates: out.candidates, pool: out.pool };
        }

        if (out.match) {
            store.map[metaCruda.faId] = { k: out.match.kind, i: out.match.id, t: out.match.title, y: out.match.year };
            flushSoon();
        }
        out.meta = full;
        return out;
    }

    // La misma película sale varias veces en una página: el póster y el título
    // son enlaces distintos, y cada uno monta su propio distintivo. Sin esto,
    // los dos repetían por su cuenta la misma tanda de consultas a TMDB.
    const RESOLVIENDO = new Map();

    function resolveMatchUnaVez(meta) {
        const clave = meta && meta.faId;
        const arrancar = function () { return queue(function () { return resolveMatch(meta); }); };
        if (!clave) return arrancar();

        const enCurso = RESOLVIENDO.get(clave);
        if (enCurso) return enCurso;

        const tarea = arrancar();
        RESOLVIENDO.set(clave, tarea);
        const soltar = function () { RESOLVIENDO.delete(clave); };
        tarea.then(soltar, soltar);
        return tarea;
    }

    function rememberChoice(faId, item) {
        if (item) store.map[faId] = { k: item.kind, i: item.id, t: item.title, y: item.year, m: 1 };
        else store.map[faId] = { none: 1 };
        flushSoon();
    }

    /* ================================================================== *
     * 6. Índices de Plex, Radarr y Sonarr
     *
     * Se descargan enteros una vez y se consultan en memoria: así navegar
     * no genera una petición por película.
     * ================================================================== */

    const IDX = { plex: null, radarr: null, sonarr: null };

    function plexHeaders() {
        return { 'X-Plex-Token': CFG.plexToken, 'Accept': 'application/json' };
    }

    function guidsOf(item) {
        const out = [];
        if (Array.isArray(item.Guid)) {
            for (const g of item.Guid) {
                const m = /^(tmdb|imdb|tvdb):\/\/(.+)$/.exec(String(g.id || ''));
                if (m) out.push(m[1] + ':' + m[2].split('?')[0]);
            }
        }
        // Agentes antiguos: com.plexapp.agents.imdb://tt0133093?lang=es
        const legacy = /com\.plexapp\.agents\.(imdb|themoviedb|thetvdb):\/\/([^?/]+)/.exec(String(item.guid || ''));
        if (legacy) {
            const kind = { imdb: 'imdb', themoviedb: 'tmdb', thetvdb: 'tvdb' }[legacy[1]];
            out.push(kind + ':' + legacy[2]);
        }
        return out;
    }

    async function buildPlexIndex() {
        if (!CFG.plexUrl || !CFG.plexToken) throw new Error('Plex sin configurar');
        const root = base(CFG.plexUrl);
        const hdr = plexHeaders();

        let machine = '';
        try {
            const ident = await gmJSON({ url: root + '/identity', headers: hdr });
            machine = (ident.MediaContainer || {}).machineIdentifier || '';
        } catch (e) { /* el enlace profundo es opcional */ }

        const secs = await gmJSON({ url: root + '/library/sections', headers: hdr });
        const dirs = ((secs.MediaContainer || {}).Directory || [])
            .filter(function (d) { return d.type === 'movie' || d.type === 'show'; });
        if (!dirs.length) throw new Error('Sin bibliotecas de cine o series');

        const guid = {};
        const byTitle = {};
        let items = 0;

        // Las bibliotecas se piden a la vez: son con diferencia la descarga más
        // pesada del arranque, y encadenarlas sumaba una espera detrás de otra.
        const bibliotecas = await Promise.all(dirs.map(function (d) {
            return gmJSON({
                url: root + '/library/sections/' + encodeURIComponent(d.key) + '/all?includeGuids=1',
                headers: hdr
            });
        }));

        for (const data of bibliotecas) {
            const list = (data.MediaContainer || {}).Metadata || [];
            for (const it of list) {
                const ref = { r: it.ratingKey, t: it.type };
                const ids = guidsOf(it);
                for (const g of ids) guid[g] = ref;
                const key = norm(it.title) + '|' + (it.year || '');
                if (!byTitle[key]) byTitle[key] = ref;
                items++;
            }
        }

        return { machine: machine, guid: guid, byTitle: byTitle, count: items };
    }

    async function buildRadarrIndex() {
        if (!CFG.radarrUrl || !CFG.radarrKey) throw new Error('Radarr sin configurar');
        const list = await gmJSON({
            url: base(CFG.radarrUrl) + '/api/v3/movie',
            headers: { 'X-Api-Key': CFG.radarrKey }
        });
        const byTmdb = {};
        for (const m of list) {
            if (!m.tmdbId) continue;
            byTmdb[m.tmdbId] = { id: m.id, files: m.hasFile ? 1 : 0, mon: m.monitored ? 1 : 0, slug: m.titleSlug || '' };
        }
        return { byTmdb: byTmdb, count: list.length };
    }

    async function buildSonarrIndex() {
        if (!CFG.sonarrUrl || !CFG.sonarrKey) throw new Error('Sonarr sin configurar');
        const root = base(CFG.sonarrUrl);
        const hdr = { 'X-Api-Key': CFG.sonarrKey };

        let major = 4, languageProfileId = null;
        try {
            const status = await gmJSON({ url: root + '/api/v3/system/status', headers: hdr });
            major = parseInt(String(status.version || '4').split('.')[0], 10) || 4;
        } catch (e) { /* se asume v4 */ }

        if (major < 4) {
            // Sonarr v3 exige languageProfileId al dar de alta una serie.
            try {
                const profiles = await gmJSON({ url: root + '/api/v3/languageprofile', headers: hdr });
                if (profiles && profiles.length) languageProfileId = profiles[0].id;
            } catch (e) { /* opcional */ }
        }

        const list = await gmJSON({ url: root + '/api/v3/series', headers: hdr });
        const byTvdb = {}, byTmdb = {};
        for (const s of list) {
            const st = s.statistics || {};
            const temporadas = {};
            (s.seasons || []).forEach(function (t) {
                const et = t.statistics || {};
                temporadas[t.seasonNumber] = {
                    files: et.episodeFileCount || 0,
                    total: et.totalEpisodeCount || 0,
                    mon: t.monitored ? 1 : 0
                };
            });
            const ref = {
                id: s.id,
                files: st.episodeFileCount || 0,
                total: st.totalEpisodeCount || st.episodeCount || 0,
                mon: s.monitored ? 1 : 0,
                slug: s.titleSlug || '',
                temporadas: temporadas
            };
            if (s.tvdbId) byTvdb[s.tvdbId] = ref;
            if (s.tmdbId) byTmdb[s.tmdbId] = ref;
        }
        return { byTvdb: byTvdb, byTmdb: byTmdb, count: list.length, major: major, languageProfileId: languageProfileId };
    }

    const BUILDERS = { plex: buildPlexIndex, radarr: buildRadarrIndex, sonarr: buildSonarrIndex };

    let indexesReady = null;

    async function loadIndexes(force) {
        const cached = readJSON(IDX_KEY, {});
        const ttl = Math.max(1, CFG.indexTtlHours || 6) * 3600 * 1000;
        const jobs = [];

        for (const name of ['plex', 'radarr', 'sonarr']) {
            const entry = cached[name];
            const fresh = entry && (Date.now() - entry.ts) < ttl;
            if (!force && fresh) {
                IDX[name] = entry.data;
                progServicio(name, 'listo');
                continue;
            }
            progServicio(name, 'cargando');
            jobs.push(
                BUILDERS[name]()
                    .then(function (data) {
                        IDX[name] = data;
                        cached[name] = { ts: Date.now(), data: data };
                        progServicio(name, 'listo');
                    })
                    .catch(function (err) {
                        IDX[name] = { error: err.message || String(err) };
                        if (entry) IDX[name] = Object.assign({}, entry.data, { stale: true });
                        progServicio(name, 'error');
                    })
            );
        }

        await Promise.all(jobs);
        // Guardar el índice entero cuesta un buen rato cuando la biblioteca es
        // grande: solo se reescribe si de verdad se ha descargado algo.
        if (jobs.length) writeJSON(IDX_KEY, cached);
        return IDX;
    }

    function ensureIndexes(force) {
        if (force || !indexesReady) indexesReady = loadIndexes(force);
        return indexesReady;
    }

    /* ================================================================== *
     * 7. Estado de un título
     * ================================================================== */

    async function statusFor(match, temporada) {
        const plex = (IDX.plex && IDX.plex.guid) ? IDX.plex : null;
        let hit = plex ? plex.guid['tmdb:' + match.id] : null;
        let arr = null;
        let tvdb = null;

        if (match.kind === 'tv') {
            const son = IDX.sonarr || {};
            arr = (son.byTmdb || {})[match.id] || null;
            if (!hit || !arr) {
                try { tvdb = await tmdbTvdbId(match.id); } catch (e) { tvdb = null; }
                if (tvdb) {
                    if (!hit && plex) hit = plex.guid['tvdb:' + tvdb] || null;
                    if (!arr) arr = (son.byTvdb || {})[tvdb] || null;
                }
            }
        } else {
            arr = ((IDX.radarr || {}).byTmdb || {})[match.id] || null;
        }

        // Último recurso: coincidencia por título normalizado y año.
        if (!hit && plex && match.title && match.year) {
            hit = plex.byTitle[norm(match.title) + '|' + match.year] || null;
        }

        let estado;
        if (hit) {
            estado = { state: 'plex', ratingKey: hit.r, machine: plex.machine || '', arr: arr, tvdb: tvdb };
        } else if (arr) {
            const hasFiles = match.kind === 'tv' ? arr.files > 0 : arr.files === 1;
            estado = { state: hasFiles ? 'downloaded' : 'queued', arr: arr, tvdb: tvdb };
        } else {
            estado = { state: 'missing', tvdb: tvdb };
        }

        // FilmAffinity abre una ficha por temporada. Si se sabe cuál es y Sonarr
        // tiene la serie, se mira esa temporada en concreto: tener la serie no
        // significa tener justo la temporada que estás mirando.
        if (temporada && arr && arr.temporadas && (estado.state === 'plex' || estado.state === 'downloaded')) {
            const t = arr.temporadas[temporada];
            if (t && t.files === 0) {
                estado = { state: 'queued', arr: arr, tvdb: tvdb, temporadaVacia: temporada };
            }
        }
        estado.temporada = temporada || null;
        return estado;
    }

    /* ================================================================== *
     * 8. Alta en Radarr y Sonarr
     * ================================================================== */

    // Radarr y Sonarr no guardan los metadatos: los piden a servidores propios
    // (api.radarr.video, skyhook.sonarr.tv). Si esos están inalcanzables, la
    // petición se queda colgada aunque el servicio local responda de sobra, y
    // el error por defecto haría pensar que el problema es la red de casa.
    function errorDeMetadatos(err, servicio, indice) {
        const colgada = /tiempo de espera/i.test(err && err.message ? err.message : '');
        const localResponde = indice && !indice.error;
        if (colgada && localResponde) {
            return new Error(servicio + ' responde, pero no alcanza su servidor de metadatos. ' +
                             'Suele ser un bloqueo de IPs de Cloudflare: mira el README.');
        }
        return err;
    }

    async function addToRadarr(match) {
        if (!CFG.radarrKey) throw new Error('Falta la API key de Radarr');
        if (!CFG.radarrProfileId || !CFG.radarrRoot) throw new Error('Configura perfil de calidad y carpeta raíz de Radarr');

        const root = base(CFG.radarrUrl);
        const hdr = { 'X-Api-Key': CFG.radarrKey, 'Content-Type': 'application/json' };

        let found;
        try {
            found = await gmJSON({
                url: root + '/api/v3/movie/lookup?term=' + encodeURIComponent('tmdb:' + match.id),
                headers: hdr,
                timeout: 60000
            });
        } catch (e) {
            throw errorDeMetadatos(e, 'Radarr', IDX.radarr);
        }
        const base_ = Array.isArray(found) ? found[0] : found;
        if (!base_) throw new Error('Radarr no encuentra ese tmdbId');

        const body = Object.assign({}, base_, {
            qualityProfileId: CFG.radarrProfileId,
            rootFolderPath: CFG.radarrRoot,
            minimumAvailability: CFG.radarrMinAvail || 'released',
            monitored: true,
            addOptions: { searchForMovie: !!CFG.radarrSearch }
        });

        let created;
        try {
            created = await gmJSON({
                method: 'POST', url: root + '/api/v3/movie', headers: hdr,
                body: JSON.stringify(body), timeout: 60000
            });
        } catch (e) {
            throw errorDeMetadatos(e, 'Radarr', IDX.radarr);
        }

        // Refleja el alta en el índice para que el resto de chips de la página coincida.
        if (IDX.radarr && IDX.radarr.byTmdb) {
            IDX.radarr.byTmdb[match.id] = { id: created.id, files: 0, mon: 1, slug: created.titleSlug || '' };
        }
        return created;
    }

    async function addToSonarr(match, tvdbId) {
        if (!CFG.sonarrKey) throw new Error('Falta la API key de Sonarr');
        if (!CFG.sonarrProfileId || !CFG.sonarrRoot) throw new Error('Configura perfil de calidad y carpeta raíz de Sonarr');

        const root = base(CFG.sonarrUrl);
        const hdr = { 'X-Api-Key': CFG.sonarrKey, 'Content-Type': 'application/json' };

        let tvdb = tvdbId;
        if (!tvdb) {
            try { tvdb = await tmdbTvdbId(match.id); } catch (e) { tvdb = null; }
        }

        const terms = [];
        if (tvdb) terms.push('tvdb:' + tvdb);
        terms.push('tmdb:' + match.id);
        if (match.title) terms.push(match.title);

        let base_ = null;
        let ultimoFallo = null;
        for (const term of terms) {
            try {
                const found = await gmJSON({
                    url: root + '/api/v3/series/lookup?term=' + encodeURIComponent(term),
                    headers: hdr,
                    timeout: 60000
                });
                if (Array.isArray(found) && found.length) { base_ = found[0]; break; }
            } catch (e) {
                ultimoFallo = e;   // se prueba el siguiente término
            }
        }
        if (!base_) {
            if (ultimoFallo) throw errorDeMetadatos(ultimoFallo, 'Sonarr', IDX.sonarr);
            throw new Error('Sonarr no encuentra esa serie');
        }

        const body = Object.assign({}, base_, {
            qualityProfileId: CFG.sonarrProfileId,
            rootFolderPath: CFG.sonarrRoot,
            seasonFolder: true,
            monitored: true,
            addOptions: {
                monitor: CFG.sonarrMonitor || 'all',
                searchForMissingEpisodes: !!CFG.sonarrSearch,
                searchForCutoffUnmetEpisodes: false
            }
        });
        if (IDX.sonarr && IDX.sonarr.major < 4 && IDX.sonarr.languageProfileId) {
            body.languageProfileId = IDX.sonarr.languageProfileId;
        }

        let created;
        try {
            created = await gmJSON({
                method: 'POST', url: root + '/api/v3/series', headers: hdr,
                body: JSON.stringify(body), timeout: 60000
            });
        } catch (e) {
            throw errorDeMetadatos(e, 'Sonarr', IDX.sonarr);
        }

        if (IDX.sonarr) {
            const ref = { id: created.id, files: 0, total: 0, mon: 1, slug: created.titleSlug || '' };
            if (created.tvdbId && IDX.sonarr.byTvdb) IDX.sonarr.byTvdb[created.tvdbId] = ref;
            if (IDX.sonarr.byTmdb) IDX.sonarr.byTmdb[match.id] = ref;
        }
        return created;
    }

    async function sendToService(match, status) {
        if (match.kind === 'tv') return addToSonarr(match, status ? status.tvdb : null);
        return addToRadarr(match);
    }

    /* ================================================================== *
     * 9. Estilos y chips
     * ================================================================== */

    const STYLE = [
        '.fam-wrap { position: relative !important; }',
        '.fam-chip { display:inline-flex; align-items:center; justify-content:center; gap:3px;',
        '  font: 700 11px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; letter-spacing:.02em;',
        '  min-width:20px; height:20px; padding:0 6px; border-radius:5px; color:#fff; background:#555;',
        '  cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,.5); user-select:none; text-decoration:none;',
        '  transition: transform .08s ease, filter .08s ease; }',
        '.fam-chip:hover { transform: scale(1.08); filter: brightness(1.12); }',
        '.fam-corner { position:absolute; top:5px; left:5px; z-index:40; }',
        '.fam-inline { position:static; margin-left:6px; vertical-align:middle; }',
        '.fam-big { position:static; margin-left:10px; vertical-align:middle; height:26px; font-size:13px; padding:0 10px; }',
        '.fam-plex { background:#e5a00d; color:#1c1c1c; }',
        '.fam-downloaded { background:#2e7d32; }',
        '.fam-queued { background:#8a5a00; }',
        '.fam-missing { background:#1f5fa8; }',
        '.fam-unknown { background:#6b6b6b; }',
        '.fam-error { background:#a02020; }',
        '.fam-loading, .fam-busy { background:#4a4a4a; opacity:.75; cursor:default; }',
        '.fam-picker { position:absolute; z-index:99999; width:340px; max-height:420px; overflow-y:auto;',
        '  overscroll-behavior: contain;',
        '  background:#1e1e1e; color:#eee; border:1px solid #444; border-radius:8px;',
        '  font: 13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; box-shadow:0 8px 28px rgba(0,0,0,.6); }',
        '.fam-picker-head { padding:9px 12px; font-weight:700; border-bottom:1px solid #383838; background:#262626; }',
        '.fam-picker-body { padding:4px; }',
        '.fam-row { display:flex; gap:9px; padding:7px; border-radius:6px; cursor:pointer; align-items:center; }',
        '.fam-row:hover { background:#333; }',
        '.fam-actual { background:#26331f; box-shadow: inset 3px 0 0 #8bc34a; }',
        '.fam-actual .fam-s { color:#8bc34a; }',
        '.fam-row img { width:40px; height:60px; object-fit:cover; border-radius:3px; background:#333; flex:0 0 auto; }',
        '.fam-row .fam-t { font-weight:600; }',
        '.fam-row .fam-s { color:#aaa; font-size:12px; }',
        '.fam-picker-foot { display:flex; gap:8px; padding:8px 10px; border-top:1px solid #383838; background:#262626; }',
        '.fam-picker-foot button { flex:1; padding:6px 8px; border-radius:5px; border:1px solid #555;',
        '  background:#333; color:#eee; cursor:pointer; font-size:12px; }',
        '.fam-picker-foot button:hover { background:#3d3d3d; }',
        '.fam-prog { position:fixed; right:18px; bottom:18px; z-index:99990; width:246px;',
        '  padding:10px 13px 12px; border-radius:8px; background:#1e1e1e; color:#eee;',
        '  border:1px solid #444; box-shadow:0 8px 28px rgba(0,0,0,.6); cursor:pointer;',
        '  font: 12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
        '  opacity:0; transform:translateY(10px); pointer-events:none;',
        '  transition: opacity .2s ease, transform .2s ease; }',
        '.fam-prog-on { opacity:1; transform:none; pointer-events:auto; }',
        '.fam-prog-cab { font: 700 10px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
        '  letter-spacing:.09em; text-transform:uppercase; color:#e5a00d; margin-bottom:6px; }',
        '.fam-prog-txt { margin-bottom:8px; color:#ddd; }',
        '.fam-prog-rail { height:4px; border-radius:3px; background:#3a3a3a; overflow:hidden; }',
        '.fam-prog-bar { height:100%; width:0; border-radius:3px; background:#e5a00d;',
        '  transition: width .3s ease; }',
        '.fam-prog-mal { border-color:#a02020; }',
        '.fam-prog-mal .fam-prog-bar { background:#a02020; }',
        '.fam-toast { position:fixed; right:18px; bottom:18px; z-index:100000; max-width:380px;',
        '  padding:11px 14px; border-radius:8px; background:#1e1e1e; color:#eee; border:1px solid #444;',
        '  font: 13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; box-shadow:0 8px 28px rgba(0,0,0,.6); }',
        '.fam-toast.fam-bad { border-color:#a02020; }',
        '.fam-toast.fam-alto { bottom:100px; }'
    ].join('\n');

    const STATES = {
        loading:    { cls: 'fam-loading',    label: '···', tip: 'Comprobando' },
        busy:       { cls: 'fam-busy',       label: '···', tip: 'Enviando' },
        plex:       { cls: 'fam-plex',       label: '▸ PLEX',        tip: 'En tu servidor Plex' },
        downloaded: { cls: 'fam-downloaded', label: '✔',             tip: 'Descargada, aun no visible en Plex' },
        queued:     { cls: 'fam-queued',     label: '↓',             tip: 'Monitorizada, sin archivo todavia' },
        missing:    { cls: 'fam-missing',    label: '+',                  tip: 'No la tienes' },
        unknown:    { cls: 'fam-unknown',    label: '?',                  tip: 'Sin coincidencia clara en TMDB' },
        error:      { cls: 'fam-error',      label: '!',                  tip: 'Error' }
    };

    function setChip(chip, state, tip) {
        const def = STATES[state] || STATES.error;
        let label = def.label;
        if (state === 'missing' && chip._match) label = chip._match.kind === 'tv' ? '+S' : '+R';
        chip.className = 'fam-chip fam-ui fam-' + chip._mode + ' ' + def.cls;
        chip.textContent = label;
        chip.title = tip || def.tip;
        chip._state = state;
    }

    function makeChip(meta, mode) {
        const chip = document.createElement('span');
        chip._meta = meta;
        chip._mode = mode;
        chip.className = 'fam-chip fam-ui fam-' + mode;
        chip.addEventListener('click', onChipClick, true);
        setChip(chip, 'loading');
        return chip;
    }

    /* ================================================================== *
     * 10. Montaje sobre la página
     * ================================================================== */

    const io = new IntersectionObserver(function (entries) {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.unobserve(entry.target);
            process(entry.target);
        }
    }, { rootMargin: '300px 0px' });

    function hasChip(host) {
        return !!host.querySelector(':scope > .fam-chip');
    }

    function mountCard(card) {
        const meta = extractFromCard(card);
        if (!meta.faId) return;
        const host = card.querySelector('.mc-poster') ||
                     card.querySelector('.poster-col a') ||
                     card.querySelector('.poster-col');
        if (!host || hasChip(host)) return;
        host.classList.add('fam-wrap');
        const chip = makeChip(meta, 'corner');
        host.appendChild(chip);
        io.observe(chip);
    }

    const SELF_FILM_ID = idFromHref(location.pathname);

    function mountAnchor(a) {
        if (a.closest('.movie-card') || a.closest('.fam-ui')) return;
        const meta = extractFromAnchor(a);
        if (!meta.faId) return;
        if (SELF_FILM_ID && meta.faId === SELF_FILM_ID) return;   // enlace a la propia ficha

        const img = a.querySelector('img');
        if (img) {
            const host = a.querySelector('.mc-oposter, .fa-movie-poster') || a;
            if (hasChip(host)) return;
            host.classList.add('fam-wrap');
            const chip = makeChip(meta, 'corner');
            host.appendChild(chip);
            io.observe(chip);
        } else {
            const host = a.parentElement;
            if (!host) return;
            const dup = Array.prototype.some.call(host.children, function (n) {
                return n.classList && n.classList.contains('fam-chip') &&
                       n._meta && n._meta.faId === meta.faId;
            });
            if (dup) return;
            const chip = makeChip(meta, 'inline');
            a.insertAdjacentElement('afterend', chip);
            io.observe(chip);
        }
    }

    function mountFicha() {
        const h1 = document.querySelector('h1#main-title');
        if (!h1 || h1.querySelector('.fam-chip')) return;
        const faId = idFromHref(location.pathname);
        if (!faId) return;
        const meta = readFicha(document, faId);
        store.meta[faId] = meta;
        flushSoon();
        const chip = makeChip(meta, 'big');
        h1.appendChild(chip);
        process(chip);   // en la ficha no se espera al scroll
    }

    function scan(root) {
        root = root || document;
        if (isFichaPage()) mountFicha();
        root.querySelectorAll('div.movie-card[data-movie-id]').forEach(mountCard);
        root.querySelectorAll('a[href*="/film"]').forEach(mountAnchor);
    }

    /* ================================================================== *
     * 11. Ciclo de un chip
     * ================================================================== */

    async function process(chip) {
        const meta = chip._meta;
        progFicha();
        try {
            if (!CFG.tmdbKey) {
                setChip(chip, 'error', 'Falta la API key de TMDB: menu de Tampermonkey, FA-Monkey ajustes');
                return;
            }
            // Identificar el título en TMDB no necesita los índices de Plex,
            // Radarr y Sonarr: lanzados a la vez, las dos esperas se solapan en
            // vez de sumarse. El índice solo hace falta al pintar el estado.
            const indices = ensureIndexes(false);
            const r = await resolveMatchUnaVez(meta);
            chip._candidates = r.candidates || [];
            chip._meta = r.meta || meta;
            if (!r.match) {
                setChip(chip, 'unknown', r.ignored
                    ? 'Marcada como ignorada. Clic para volver a elegir'
                    : 'Sin coincidencia clara en TMDB. Clic para elegir');
                return;
            }
            chip._match = r.match;
            await indices;
            await applyStatus(chip);
        } catch (e) {
            setChip(chip, 'error', e.message || String(e));
        } finally {
            progFichaHecha();
        }
    }

    async function applyStatus(chip) {
        const match = chip._match;
        if (!match) return;
        const temporada = (chip._meta && chip._meta.season) || null;
        const st = await statusFor(match, temporada);
        chip._status = st;
        const service = match.kind === 'tv' ? 'Sonarr' : 'Radarr';
        const coletilla = temporada ? ' T' + temporada : '';
        const name = (match.title || '') + coletilla + (match.year ? ' (' + match.year + ')' : '');
        if (st.temporadaVacia) {
            setChip(chip, 'queued', 'Tienes la serie, pero no la temporada ' + st.temporadaVacia + ': ' + (match.title || ''));
        } else if (st.state === 'plex') {
            setChip(chip, 'plex', 'En Plex: ' + name);
        } else if (st.state === 'downloaded') {
            setChip(chip, 'downloaded', 'Descargada en ' + service + ', aun no visible en Plex: ' + name);
        } else if (st.state === 'queued') {
            setChip(chip, 'queued', 'En ' + service + ' sin archivo todavia: ' + name);
        } else {
            setChip(chip, 'missing', 'No la tienes. Clic para enviar a ' + service + ': ' + name);
        }
    }

    function refreshMatching(predicate) {
        document.querySelectorAll('.fam-chip').forEach(function (c) {
            if (c._match && predicate(c)) applyStatus(c);
        });
    }

    async function onChipClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const chip = e.currentTarget;
        const state = chip._state;
        if (state === 'loading' || state === 'busy') return;
        if (e.shiftKey || state === 'unknown') return openPicker(chip);
        if (state === 'plex') return openInPlex(chip);
        if (state === 'queued' || state === 'downloaded') return openInArr(chip);
        if (state === 'missing') return doAdd(chip);
        if (state === 'error') return process(chip);
    }

    async function doAdd(chip) {
        const match = chip._match;
        const service = match.kind === 'tv' ? 'Sonarr' : 'Radarr';
        setChip(chip, 'busy', 'Enviando a ' + service);
        try {
            await sendToService(match, chip._status);
            toast('Enviada a ' + service + ': ' + (match.title || ''));
            refreshMatching(function (c) { return c._match.kind === match.kind && c._match.id === match.id; });
        } catch (err) {
            setChip(chip, 'error', 'Error: ' + (err.message || err));
            toast('No se pudo enviar a ' + service + ': ' + (err.message || err), true);
            setTimeout(function () { if (chip._state === 'error') applyStatus(chip); }, 5000);
        }
    }

    function openInPlex(chip) {
        const st = chip._status;
        if (!st || !st.ratingKey) return;
        const key = encodeURIComponent('/library/metadata/' + st.ratingKey);
        const url = st.machine
            ? 'https://app.plex.tv/desktop/#!/server/' + st.machine + '/details?key=' + key
            : base(CFG.plexUrl) + '/web/index.html#!/server/local/details?key=' + key;
        window.open(url, '_blank', 'noopener');
    }

    function openInArr(chip) {
        const match = chip._match;
        const st = chip._status || {};
        const slug = st.arr ? st.arr.slug : '';
        const root = match.kind === 'tv' ? base(CFG.sonarrUrl) : base(CFG.radarrUrl);
        const path = slug ? (match.kind === 'tv' ? '/series/' + slug : '/movie/' + slug) : '';
        window.open(root + path, '_blank', 'noopener');
    }

    /* ================================================================== *
     * 12. Selector manual de coincidencia
     * ================================================================== */

    let pickerEl = null;

    function closePicker() {
        if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
        pickerEl = null;
    }

    function placePicker(box, chip) {
        const r = chip.getBoundingClientRect();
        const top = window.scrollY + r.bottom + 6;
        let left = window.scrollX + r.left;
        left = Math.min(left, window.scrollX + document.documentElement.clientWidth - 356);
        box.style.top = Math.round(top) + 'px';
        box.style.left = Math.round(Math.max(8, left)) + 'px';
    }

    async function openPicker(chip) {
        closePicker();
        const box = document.createElement('div');
        box.className = 'fam-picker fam-ui';
        box.innerHTML = '<div class="fam-picker-head">Elegir coincidencia en TMDB</div>' +
                        '<div class="fam-picker-body">Buscando...</div>';
        document.body.appendChild(box);
        placePicker(box, chip);
        pickerEl = box;

        let cands = chip._candidates || [];
        if (!cands.length) {
            try {
                const meta = Object.assign({}, chip._meta, store.meta[chip._meta.faId] || {});
                const out = await queue(function () { return attemptMatch(meta); });
                cands = out.candidates || [];
                chip._candidates = cands;
            } catch (e) { cands = []; }
        }
        // La coincidencia en uso va siempre la primera y marcada, aunque la
        // búsqueda por título no la devuelva. En una ficha el identificador lo
        // publica la propia web, y entonces la lista de abajo no tiene por qué
        // contenerla: sin esto parecía que el emparejamiento hubiera fallado.
        if (chip._match) {
            const presente = cands.some(function (c) {
                return c.kind === chip._match.kind && c.id === chip._match.id;
            });
            if (!presente) {
                let actual = null;
                try {
                    actual = await tmdbPorId(chip._match.kind, chip._match.id);
                } catch (e) {
                    actual = Object.assign({ poster: null, overview: '', original: '' }, chip._match);
                }
                cands = [actual].concat(cands);
            }
        }

        if (pickerEl !== box) return;
        renderPicker(box, chip, cands);
    }

    function renderPicker(box, chip, cands) {
        const body = box.querySelector('.fam-picker-body');
        body.innerHTML = '';

        if (!cands.length) {
            body.textContent = 'TMDB no devuelve candidatos para este titulo.';
        }

        cands.forEach(function (item) {
            const esActual = chip._match && chip._match.kind === item.kind && chip._match.id === item.id;
            const row = document.createElement('div');
            row.className = 'fam-row' + (esActual ? ' fam-actual' : '');

            const img = document.createElement('img');
            img.src = item.poster ? 'https://image.tmdb.org/t/p/w92' + item.poster : '';
            img.alt = '';
            row.appendChild(img);

            const info = document.createElement('div');
            const t = document.createElement('div');
            t.className = 'fam-t';
            t.textContent = item.title || item.original || '';
            const s = document.createElement('div');
            s.className = 'fam-s';
            s.textContent = [
                esActual ? 'en uso' : '',
                item.kind === 'tv' ? 'serie' : 'pelicula',
                item.year || 's/f',
                item.original && item.original !== item.title ? item.original : ''
            ].filter(Boolean).join(' · ');
            info.appendChild(t);
            info.appendChild(s);
            row.appendChild(info);

            row.addEventListener('click', function () {
                chooseCandidate(chip, item);
                closePicker();
            });
            body.appendChild(row);
        });

        const foot = document.createElement('div');
        foot.className = 'fam-picker-foot';

        const ignore = document.createElement('button');
        ignore.textContent = 'Ignorar esta ficha';
        ignore.addEventListener('click', function () {
            rememberChoice(chip._meta.faId, null);
            chip._match = null;
            setChip(chip, 'unknown', 'Ignorada. Clic para volver a elegir');
            closePicker();
        });
        foot.appendChild(ignore);

        const close = document.createElement('button');
        close.textContent = 'Cerrar';
        close.addEventListener('click', closePicker);
        foot.appendChild(close);

        box.appendChild(foot);
    }

    function chooseCandidate(chip, item) {
        const faId = chip._meta.faId;
        rememberChoice(faId, item);
        document.querySelectorAll('.fam-chip').forEach(function (c) {
            if (c._meta && c._meta.faId === faId) {
                c._match = item;
                applyStatus(c);
            }
        });
    }

    document.addEventListener('click', function (e) {
        if (!pickerEl) return;
        if (pickerEl.contains(e.target)) return;
        if (e.target.classList && e.target.classList.contains('fam-chip')) return;
        closePicker();
    }, true);
    // El panel se cierra si se desplaza la página, pero no si lo que se
    // desplaza es su propia lista: al escuchar en fase de captura, el scroll de
    // dentro llegaba aquí y lo cerraba, de modo que no había forma de bajar a
    // ver el resto de candidatos ni con la rueda ni con la barra.
    window.addEventListener('scroll', function (e) {
        if (!pickerEl) return;
        const destino = e.target;
        if (destino && destino.nodeType === 1 && pickerEl.contains(destino)) return;
        closePicker();
    }, true);

    /* ================================================================== *
     * 13. Barra de progreso
     *
     * La primera carga descarga enteros los catálogos de Plex, Radarr y Sonarr
     * y luego pregunta a TMDB por cada póster: puede irse a un minuto largo.
     * Sin nada en pantalla parece que el script no funciona, así que cuenta en
     * voz alta por dónde va. Solo asoma si de verdad tarda, y una vez que ha
     * terminado no vuelve a aparecer mientras dure la página.
     * ================================================================== */

    const PROG_NOMBRES = { plex: 'Plex', radarr: 'Radarr', sonarr: 'Sonarr' };

    const PROG = {
        caja: null, texto: null, barra: null,
        servicios: {},          // nombre -> 'cargando' | 'listo' | 'error'
        fichas: 0,              // distintivos puestos en marcha
        hechas: 0,              // distintivos ya resueltos
        visible: false,
        terminado: false,
        verTimer: null,
        ocultarTimer: null
    };

    function progCaja() {
        if (PROG.caja) return PROG.caja;
        const caja = document.createElement('div');
        caja.className = 'fam-prog fam-ui';
        caja.title = 'FA-Monkey esta trabajando. Clic para ocultar el aviso';
        caja.innerHTML = '<div class="fam-prog-cab">FA-Monkey</div>' +
                         '<div class="fam-prog-txt"></div>' +
                         '<div class="fam-prog-rail"><div class="fam-prog-bar"></div></div>';
        caja.addEventListener('click', progOcultar, true);
        document.body.appendChild(caja);
        PROG.caja  = caja;
        PROG.texto = caja.querySelector('.fam-prog-txt');
        PROG.barra = caja.querySelector('.fam-prog-bar');
        return caja;
    }

    function progServiciosEn(estado) {
        return Object.keys(PROG.servicios)
            .filter(function (n) { return PROG.servicios[n] === estado; })
            .map(function (n) { return PROG_NOMBRES[n]; });
    }

    function progUnir(nombres) {
        if (nombres.length < 2) return nombres[0] || '';
        return nombres.slice(0, -1).join(', ') + ' y ' + nombres[nombres.length - 1];
    }

    function progPendiente() {
        return progServiciosEn('cargando').length > 0 || PROG.hechas < PROG.fichas;
    }

    function progTexto() {
        const cargando = progServiciosEn('cargando');
        if (cargando.length) return 'Leyendo lo que ya tienes en ' + progUnir(cargando) + '...';
        if (PROG.hechas < PROG.fichas) {
            return 'Identificando titulos: ' + PROG.hechas + ' de ' + PROG.fichas;
        }
        const fallos = progServiciosEn('error');
        if (fallos.length) return 'Sin respuesta de ' + progUnir(fallos);
        return 'Listo';
    }

    function progPintar() {
        const caja = progCaja();
        const servicios = Object.keys(PROG.servicios);
        const total  = servicios.length + PROG.fichas;
        const hechas = servicios.filter(function (n) { return PROG.servicios[n] !== 'cargando'; }).length +
                       Math.min(PROG.hechas, PROG.fichas);
        PROG.barra.style.width = (total ? Math.round(hechas * 100 / total) : 0) + '%';
        PROG.texto.textContent = progTexto();
        caja.classList.toggle('fam-prog-mal', progServiciosEn('error').length > 0);
        return caja;
    }

    function progMostrar() {
        PROG.verTimer = null;
        PROG.visible = true;
        const caja = progPintar();
        // El navegador necesita medir la caja antes de animarla. Se le fuerza a
        // hacerlo aquí mismo: con requestAnimationFrame, una pestaña que no está
        // pintando puede tardar en devolver el turno y la barra se queda invisible.
        void caja.offsetWidth;
        caja.classList.add('fam-prog-on');
    }

    function progOcultar() {
        clearTimeout(PROG.ocultarTimer);
        PROG.ocultarTimer = null;
        PROG.visible = false;
        PROG.terminado = true;
        const caja = PROG.caja;
        PROG.caja = null;
        if (!caja) return;
        caja.classList.remove('fam-prog-on');
        setTimeout(function () { if (caja.parentNode) caja.parentNode.removeChild(caja); }, 400);
    }

    function progRender() {
        if (PROG.terminado || !document.body) return;

        if (progPendiente()) {
            clearTimeout(PROG.ocultarTimer);
            PROG.ocultarTimer = null;
            // Medio segundo de cortesía: si estaba todo en caché no llega a verse.
            if (!PROG.visible) {
                if (!PROG.verTimer) PROG.verTimer = setTimeout(progMostrar, 500);
                return;
            }
            progPintar();
            return;
        }

        clearTimeout(PROG.verTimer);
        PROG.verTimer = null;
        if (!PROG.visible) return;      // nunca llegó a asomar: no hay nada que cerrar
        progPintar();
        if (!PROG.ocultarTimer) {
            const fallos = progServiciosEn('error').length > 0;
            PROG.ocultarTimer = setTimeout(progOcultar, fallos ? 7000 : 1600);
        }
    }

    function progServicio(nombre, estado) {
        PROG.servicios[nombre] = estado;
        progRender();
    }

    function progFicha()      { PROG.fichas++; progRender(); }
    function progFichaHecha() { PROG.hechas++; progRender(); }

    // Al refrescar los indices a mano vuelve a tener algo que contar.
    function progReiniciar() {
        PROG.terminado = false;
        PROG.servicios = {};
    }

    /* ================================================================== *
     * 13 bis. Avisos
     * ================================================================== */

    let toastTimer = null;
    function toast(msg, bad, ms) {
        let el = document.getElementById('fam-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'fam-toast';
            document.body.appendChild(el);
        }
        el.className = 'fam-toast fam-ui' + (bad ? ' fam-bad' : '') + (PROG.visible ? ' fam-alto' : '');
        el.textContent = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms || 4500);
    }

    /* ================================================================== *
     * 14. Panel de ajustes
     * ================================================================== */

    const PANEL_CSS = `
        :host { all: initial; }
        .back { position: fixed; inset: 0; z-index: 100001; background: rgba(0,0,0,.6);
                display:flex; align-items:flex-start; justify-content:center; overflow:auto; padding:40px 16px; }
        .card { width: 620px; max-width: 100%; background:#1e1e1e; color:#eee; border:1px solid #444;
                border-radius:10px; font: 13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
        h2 { margin:0; padding:14px 18px; font-size:15px; border-bottom:1px solid #383838; background:#262626;
             border-radius:10px 10px 0 0; }
        .body { padding:14px 18px; }
        fieldset { border:1px solid #3a3a3a; border-radius:8px; margin:0 0 14px; padding:10px 12px 12px; }
        legend { padding:0 6px; font-weight:700; color:#e5a00d; }
        .grid { display:grid; grid-template-columns: 150px 1fr; gap:8px 10px; align-items:center; }
        label { color:#bbb; }
        input[type=text], input[type=password], input[type=number], select {
            width:100%; box-sizing:border-box; padding:6px 8px; border-radius:5px;
            border:1px solid #555; background:#2a2a2a; color:#eee; font:inherit; }
        input[type=checkbox] { width:16px; height:16px; }
        .row-btn { grid-column: 1 / -1; display:flex; gap:8px; align-items:center; margin-top:6px; }
        button { padding:7px 12px; border-radius:6px; border:1px solid #555; background:#333; color:#eee;
                 cursor:pointer; font:inherit; }
        button:hover { background:#3d3d3d; }
        button.primary { background:#1f5fa8; border-color:#2a72c8; }
        .note { color:#999; font-size:12px; margin:4px 0 0; }
        .status { font-size:12px; color:#8bc34a; }
        .status.bad { color:#e57373; }
        .foot { display:flex; gap:8px; padding:12px 18px; border-top:1px solid #383838; background:#262626;
                border-radius:0 0 10px 10px; }
        .foot .spacer { flex:1; }
    `;

    const PANEL_HTML = `
        <div class="back">
          <div class="card">
            <h2>FA-Monkey &mdash; ajustes</h2>
            <div class="body">

              <fieldset>
                <legend>TMDB</legend>
                <div class="grid">
                  <label for="tmdbKey">API key (v3)</label>
                  <input type="password" id="tmdbKey" autocomplete="off">
                </div>
                <p class="note">Se usa para traducir cada ficha de FilmAffinity a un id de TMDB. Se obtiene gratis en themoviedb.org, ajustes de la cuenta, API.</p>
              </fieldset>

              <fieldset>
                <legend>Plex</legend>
                <div class="grid">
                  <label for="plexUrl">URL del servidor</label>
                  <input type="text" id="plexUrl" placeholder="http://192.168.1.10:32400">
                  <label for="plexToken">X-Plex-Token</label>
                  <input type="password" id="plexToken" autocomplete="off">
                  <div class="row-btn">
                    <button id="testPlex">Probar conexion</button>
                    <span class="status" id="stPlex"></span>
                  </div>
                </div>
              </fieldset>

              <fieldset>
                <legend>Radarr</legend>
                <div class="grid">
                  <label for="radarrUrl">URL</label>
                  <input type="text" id="radarrUrl" placeholder="http://192.168.1.20:7878">
                  <label for="radarrKey">API key</label>
                  <input type="password" id="radarrKey" autocomplete="off">
                  <label for="radarrProfileId">Perfil de calidad</label>
                  <select id="radarrProfileId"></select>
                  <label for="radarrRoot">Carpeta raiz</label>
                  <select id="radarrRoot"></select>
                  <label for="radarrMinAvail">Disponibilidad minima</label>
                  <select id="radarrMinAvail">
                    <option value="announced">Anunciada</option>
                    <option value="inCinemas">En cines</option>
                    <option value="released">Estrenada</option>
                  </select>
                  <label for="radarrSearch">Buscar al anadir</label>
                  <input type="checkbox" id="radarrSearch">
                  <div class="row-btn">
                    <button id="testRadarr">Probar y cargar perfiles</button>
                    <span class="status" id="stRadarr"></span>
                  </div>
                </div>
              </fieldset>

              <fieldset>
                <legend>Sonarr</legend>
                <div class="grid">
                  <label for="sonarrUrl">URL</label>
                  <input type="text" id="sonarrUrl" placeholder="http://192.168.1.20:8989">
                  <label for="sonarrKey">API key</label>
                  <input type="password" id="sonarrKey" autocomplete="off">
                  <label for="sonarrProfileId">Perfil de calidad</label>
                  <select id="sonarrProfileId"></select>
                  <label for="sonarrRoot">Carpeta raiz</label>
                  <select id="sonarrRoot"></select>
                  <label for="sonarrMonitor">Monitorizar</label>
                  <select id="sonarrMonitor">
                    <option value="all">Todos los episodios</option>
                    <option value="future">Solo futuros</option>
                    <option value="missing">Los que faltan</option>
                    <option value="firstSeason">Primera temporada</option>
                    <option value="latestSeason">Ultima temporada</option>
                    <option value="none">Ninguno</option>
                  </select>
                  <label for="sonarrSearch">Buscar al anadir</label>
                  <input type="checkbox" id="sonarrSearch">
                  <div class="row-btn">
                    <button id="testSonarr">Probar y cargar perfiles</button>
                    <span class="status" id="stSonarr"></span>
                  </div>
                </div>
              </fieldset>

              <fieldset>
                <legend>Rendimiento</legend>
                <div class="grid">
                  <label for="indexTtlHours">Caducidad del indice (h)</label>
                  <input type="number" id="indexTtlHours" min="1" max="168">
                  <label for="concurrency">Peticiones en paralelo</label>
                  <input type="number" id="concurrency" min="1" max="12">
                </div>
                <p class="note" id="idxInfo"></p>
              </fieldset>

            </div>
            <div class="foot">
              <button id="refreshIdx">Refrescar indices</button>
              <button id="clearCache">Borrar cache de coincidencias</button>
              <span class="spacer"></span>
              <button id="cancel">Cerrar</button>
              <button id="save" class="primary">Guardar</button>
            </div>
          </div>
        </div>
    `;

    function fillSelect(sel, items, valueKey, labelKey, current) {
        sel.innerHTML = '';
        items.forEach(function (it) {
            const o = document.createElement('option');
            o.value = String(it[valueKey]);
            o.textContent = String(it[labelKey]);
            sel.appendChild(o);
        });
        if (current !== null && current !== undefined && String(current)) sel.value = String(current);
    }

    function openSettings() {
        if (document.getElementById('fam-settings-host')) return;
        const host = document.createElement('div');
        host.id = 'fam-settings-host';
        host.className = 'fam-ui';
        document.body.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = PANEL_CSS;
        root.appendChild(style);
        const wrap = document.createElement('div');
        wrap.innerHTML = PANEL_HTML;
        root.appendChild(wrap);

        const $ = function (id) { return root.getElementById ? root.getElementById(id) : root.querySelector('#' + id); };

        const textFields = ['tmdbKey', 'plexUrl', 'plexToken', 'radarrUrl', 'radarrKey', 'radarrRoot',
                            'radarrMinAvail', 'sonarrUrl', 'sonarrKey', 'sonarrRoot', 'sonarrMonitor'];
        textFields.forEach(function (k) {
            const el = $(k);
            if (el) el.value = CFG[k] === null || CFG[k] === undefined ? '' : String(CFG[k]);
        });
        $('radarrSearch').checked = !!CFG.radarrSearch;
        $('sonarrSearch').checked = !!CFG.sonarrSearch;
        $('indexTtlHours').value = CFG.indexTtlHours;
        $('concurrency').value = CFG.concurrency;

        // Los perfiles guardados se muestran aunque todavia no se haya probado la conexion.
        if (CFG.radarrProfileId) fillSelect($('radarrProfileId'), [{ id: CFG.radarrProfileId, name: 'Perfil ' + CFG.radarrProfileId }], 'id', 'name', CFG.radarrProfileId);
        if (CFG.sonarrProfileId) fillSelect($('sonarrProfileId'), [{ id: CFG.sonarrProfileId, name: 'Perfil ' + CFG.sonarrProfileId }], 'id', 'name', CFG.sonarrProfileId);
        if (CFG.radarrRoot) fillSelect($('radarrRoot'), [{ path: CFG.radarrRoot }], 'path', 'path', CFG.radarrRoot);
        if (CFG.sonarrRoot) fillSelect($('sonarrRoot'), [{ path: CFG.sonarrRoot }], 'path', 'path', CFG.sonarrRoot);

        const info = [];
        ['plex', 'radarr', 'sonarr'].forEach(function (k) {
            const d = IDX[k];
            if (!d) info.push(k + ': sin cargar');
            else if (d.error) info.push(k + ': ' + d.error);
            else info.push(k + ': ' + (d.count || 0) + ' elementos');
        });
        $('idxInfo').textContent = 'Indices - ' + info.join('  |  ');

        function status(el, msg, bad) {
            el.textContent = msg;
            el.className = 'status' + (bad ? ' bad' : '');
        }

        $('testPlex').addEventListener('click', async function () {
            const st = $('stPlex');
            status(st, 'Conectando...');
            allowHost($('plexUrl').value);
            try {
                const secs = await gmJSON({
                    url: base($('plexUrl').value) + '/library/sections',
                    headers: { 'X-Plex-Token': $('plexToken').value, 'Accept': 'application/json' }
                });
                const dirs = ((secs.MediaContainer || {}).Directory || [])
                    .filter(function (d) { return d.type === 'movie' || d.type === 'show'; });
                status(st, dirs.length + ' bibliotecas de cine y series');
            } catch (e) {
                status(st, e.message || String(e), true);
            }
        });

        async function testArr(kind) {
            const st = $(kind === 'radarr' ? 'stRadarr' : 'stSonarr');
            const url = base($(kind + 'Url').value);
            const key = $(kind + 'Key').value;
            status(st, 'Conectando...');
            allowHost(url);
            try {
                const hdr = { 'X-Api-Key': key };
                const profiles = await gmJSON({ url: url + '/api/v3/qualityprofile', headers: hdr });
                const folders = await gmJSON({ url: url + '/api/v3/rootfolder', headers: hdr });
                fillSelect($(kind + 'ProfileId'), profiles, 'id', 'name', CFG[kind + 'ProfileId']);
                fillSelect($(kind + 'Root'), folders, 'path', 'path', CFG[kind + 'Root']);
                status(st, profiles.length + ' perfiles, ' + folders.length + ' carpetas');
            } catch (e) {
                status(st, e.message || String(e), true);
            }
        }
        $('testRadarr').addEventListener('click', function () { testArr('radarr'); });
        $('testSonarr').addEventListener('click', function () { testArr('sonarr'); });

        function close() {
            if (host.parentNode) host.parentNode.removeChild(host);
        }

        $('cancel').addEventListener('click', close);

        $('save').addEventListener('click', function () {
            textFields.forEach(function (k) {
                const el = $(k);
                if (el) CFG[k] = el.value.trim();
            });
            CFG.radarrProfileId = parseInt($('radarrProfileId').value, 10) || null;
            CFG.sonarrProfileId = parseInt($('sonarrProfileId').value, 10) || null;
            CFG.radarrSearch = $('radarrSearch').checked;
            CFG.sonarrSearch = $('sonarrSearch').checked;
            CFG.indexTtlHours = parseInt($('indexTtlHours').value, 10) || 6;
            CFG.concurrency = parseInt($('concurrency').value, 10) || 6;
            writeJSON(CFG_KEY, CFG);
            close();
            toast('Ajustes guardados. Recargando indices...');
            ensureIndexes(true).then(function () {
                refreshMatching(function () { return true; });
                toast('Indices actualizados');
            });
        });

        $('refreshIdx').addEventListener('click', function () {
            status($('stPlex'), 'Recargando indices...');
            ensureIndexes(true).then(function () {
                refreshMatching(function () { return true; });
                status($('stPlex'), 'Indices actualizados');
            });
        });

        $('clearCache').addEventListener('click', function () {
            store.map = {}; store.meta = {}; store.tvdb = {};
            writeJSON(MAP_KEY, {}); writeJSON(META_KEY, {}); writeJSON(TVDB_KEY, {});
            toast('Cache de coincidencias borrada. Recarga la pagina.');
        });
    }

    /* ================================================================== *
     * 15. Arranque
     * ================================================================== */

    let scanTimer = null;
    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(function () { scan(document); }, 400);
    }

    function boot() {
        GM_addStyle(STYLE);

        GM_registerMenuCommand('FA-Monkey: ajustes', openSettings);
        GM_registerMenuCommand('FA-Monkey: refrescar indices', function () {
            progReiniciar();
            toast('Recargando indices...');
            ensureIndexes(true).then(function () {
                refreshMatching(function () { return true; });
                toast('Indices actualizados');
            });
        });
        GM_registerMenuCommand('FA-Monkey: borrar cache de coincidencias', function () {
            store.map = {}; store.meta = {}; store.tvdb = {};
            writeJSON(MAP_KEY, {}); writeJSON(META_KEY, {}); writeJSON(TVDB_KEY, {});
            toast('Cache borrada. Recarga la pagina.');
        });

        if (!CFG.tmdbKey || !CFG.plexToken) {
            toast('FA-Monkey necesita configurarse: menu de Tampermonkey, FA-Monkey ajustes', false, 9000);
        }

        scan(document);

        const mo = new MutationObserver(function (muts) {
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === 1 && !(n.classList && n.classList.contains('fam-ui'))) {
                        scheduleScan();
                        return;
                    }
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
