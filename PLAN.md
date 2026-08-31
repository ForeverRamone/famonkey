# FA-Monkey — Plan de implementación

Userscript de Tampermonkey que, navegando por FilmAffinity, marca sobre cada póster
si la película o serie ya está en el servidor Plex del usuario, y permite enviarla a
Radarr o Sonarr con un clic.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Envío de peticiones | Radarr y Sonarr directos (sin Overseerr) |
| Fuente de disponibilidad | Plex (índice completo) + estado de Radarr/Sonarr |
| Alcance | Todo `filmaffinity.com` |
| Resolución | Automática y perezosa, al entrar el item en pantalla |

## 1. Reconocimiento del DOM (verificado sobre HTML real)

Cuatro variantes de marcado, todas identificables por un enlace a `/filmNNNNNN.html`:

| Contexto | Selector raíz | Datos obtenibles |
|---|---|---|
| Póster de portada | `a[href*="/film"] > div.mc-oposter` | título ES (`title` del `<a>`), tipo, slug del póster |
| Lista de texto en portada | `li.list-group-item .movie-title > a` | solo título ES |
| Listados, búsqueda, top | `div.movie-card[data-movie-id]` | `.mc-title`, `.mc-year`, país, slug |
| Ficha | `dl.movie-info` | título original, año, duración, país, dirección, AKAs |

### Dos hallazgos que sostienen el diseño

1. **El slug de la imagen del póster contiene el título original**, no el español.
   `Cuatro manos, dos sonatas` → `four_hands_two_sonatas`; `Cementerio` → `mezarlik`;
   `Matrix` → `the_matrix`. Está disponible en portada y en listados sin fetch adicional,
   y es el mejor input posible para buscar en TMDB.

2. **Peli vs serie sale del propio título**: `(Serie de TV)`, `(Miniserie de TV)`,
   `(TV)` telefilme, `(C)` cortometraje. No hace falta un intermediario para decidir
   entre Radarr y Sonarr.

Punto débil: la portada **no muestra año**. Los listados y las fichas sí.

## 2. Arquitectura

Un único `.user.js`, módulos internos, sin dependencias externas.

```
config      GM_getValue/GM_setValue + panel de ajustes en Shadow DOM
scanner     detecta items en las 4 variantes; MutationObserver + IntersectionObserver
extractor   faId, título ES, título original, año, tipo, país
resolver    FA id -> TMDB id            [caché permanente]
index       Plex / Radarr / Sonarr      [carga masiva, caché con TTL]
badge       pinta y actualiza el chip sobre el póster
actions     POST a Radarr / Sonarr
```

### Principio de rendimiento

Nada de una consulta por película. Se cargan **índices completos una sola vez** y se
consultan en memoria. Lo único que se resuelve por película es su TMDB id, y ese mapeo
se cachea de forma permanente porque no cambia nunca.

Primera visita a portada: ~50 búsquedas en TMDB. Visitas siguientes: cero peticiones.

## 3. Resolución FA -> TMDB (cascada)

1. Caché `faId -> tmdbId`. Si existe, fin.
2. TMDB `/search/movie` o `/search/tv` con el título original del slug, más el año si
   la página lo muestra.
3. Sin año y con varios candidatos: segunda búsqueda con el título español
   (`language=es-ES`) e intersección de resultados.
4. Aún ambiguo: fetch en segundo plano de la ficha de FilmAffinity (mismo dominio,
   ~58 KB) para extraer año y dirección, y desempatar.
5. Sin match convincente: chip gris `?`. Al pulsarlo se abre un selector con los
   candidatos de TMDB; la elección se guarda de forma permanente.

Casos límite: los cortos `(C)` se marcan como no soportados; los telefilmes `(TV)` se
buscan primero como película y luego como serie.

## 4. Índices

### Plex
- `GET {plex}/library/sections` → secciones de tipo `movie` y `show`.
- `GET {plex}/library/sections/{key}/all?includeGuids=1` → cada item con sus GUIDs
  (`tmdb://`, `imdb://`, `tvdb://`).
- Soportar también el agente antiguo, que devuelve
  `com.plexapp.agents.imdb://tt0133093?lang=en` en el campo `guid`.
- `machineIdentifier` desde `GET {plex}/identity`, para poder enlazar al item.
- Se guarda compacto: GUID -> `{ratingKey, type}`, más un índice de respaldo por
  título normalizado + año.
- Cabecera `X-Plex-Token` y `Accept: application/json`.

### Radarr
`GET /api/v3/movie` → `tmdbId`, `hasFile`, `monitored`. Cabecera `X-Api-Key`.

### Sonarr
`GET /api/v3/series` → `tvdbId`, `tmdbId`, `statistics.episodeFileCount`.
Cuando haga falta traducir TMDB -> TVDB: `GET /tv/{id}/external_ids` de TMDB, cacheado.

TTL de los índices: 6 h, con refresco manual desde el panel y refresco automático
después de añadir algo.

## 5. Alta en Radarr / Sonarr

Para no construir a mano el objeto que espera la API, se hace lookup y se devuelve
el objeto recibido con los campos de configuración añadidos:

- Radarr: `GET /api/v3/movie/lookup?term=tmdb:{id}` → POST `/api/v3/movie` con
  `qualityProfileId`, `rootFolderPath`, `minimumAvailability`, `monitored: true`,
  `addOptions: { searchForMovie: true }`.
- Sonarr: `GET /api/v3/series/lookup?term=tvdb:{id}` → POST `/api/v3/series` con
  `qualityProfileId`, `rootFolderPath`, `seasonFolder: true`, `monitored: true`,
  `addOptions: { monitor: 'all', searchForMissingEpisodes: true }`.

Los desplegables de perfil de calidad y carpeta raíz del panel se rellenan desde
`/api/v3/qualityprofile` y `/api/v3/rootfolder`.

## 6. Estados del chip

| Estado | Aspecto | Significado | Click |
|---|---|---|---|
| Disponible | verde, `PLEX` | está en el servidor | abre el item en Plex |
| En cola | ámbar, reloj | en Radarr/Sonarr, sin archivo aún | abre el item en Radarr/Sonarr |
| Ausente | azul, `+R` / `+S` | no está en ningún sitio | lo envía |
| Sin match | gris, `?` | TMDB no resuelto con confianza | abre el selector de candidatos |
| Error | rojo | fallo de red o de API | tooltip con el motivo |

Chip pequeño en la esquina del póster; en la ficha, botón grande con texto.
Al enviar algo, el chip pasa a ámbar de inmediato sin esperar al refresco del índice.

## 7. Seguridad

- La cabecera declara `@connect *` para que cada usuario pueda apuntar a sus
  propias direcciones sin editar el código, y la restricción se aplica en el
  script: una comprobación en el único punto por el que sale una petición deja
  pasar solo TMDB, la propia web y los servicios configurados. Así el token de
  Plex y las API keys no pueden acabar en un tercer host, y además el filtro
  sigue automáticamente a la configuración en vez de a una lista fija.
- `GM_xmlhttpRequest` para todo, lo que evita CORS y el bloqueo de contenido mixto:
  un Radarr en `http://192.168.1.x:7878` funciona desde la página HTTPS de FilmAffinity.
- Las claves se introducen en el panel de ajustes del script, no se escriben en el
  código fuente.

## 8. Estado

Implementado en `famonkey.user.js` y verificado con tres bancos de pruebas sobre
HTML real descargado de FilmAffinity:

- Portada, búsqueda y ficha: 174, 27 y 1 distintivos montados respectivamente,
  con el tipo, el año y el título original bien extraídos en cada maquetación.
- Cascada de desambiguación: candidato único sin leer la ficha; tres candidatos
  con años distintos resueltos leyendo la ficha y reevaluando lo ya encontrado;
  empate irresoluble entregado al selector manual en vez de adivinar.
- Envío: cuerpo de la petición a Radarr y a Sonarr comprobado campo a campo.
- Comprobación visual en navegador, incluida la resolución perezosa al hacer
  scroll y el selector de candidatos.

Bugs encontrados y corregidos durante esa verificación:

1. `querySelector('.mc-title a, .mc-title')` devolvía el contenedor, no el
   enlace, y como lleva dos enlaces (escritorio y móvil) el título salía
   duplicado: "Matrix Matrix".
2. En una ficha, la pestaña "Ficha" enlaza a la propia película y provocaba un
   segundo distintivo.
3. Al leer la ficha para desambiguar se tiraban los candidatos ya encontrados en
   lugar de reevaluarlos con el año recién obtenido, de modo que un caso
   resoluble acababa en el selector manual y con siete peticiones en vez de tres.

## 9. Riesgos

- FilmAffinity cambia el marcado. Mitigación: todos los selectores en un único módulo.
- Títulos sin año en portada. Mitigación: la cascada de resolución y el selector manual.
- Series sin `tvdb_id` en TMDB. Mitigación: lookup en Sonarr por `tmdb:` como respaldo.
- Escritura en `GM_setValue` con miles de entradas. Mitigación: mapa en memoria y
  volcado diferido.
