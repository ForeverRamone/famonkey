# FA-Monkey

Userscript de Tampermonkey para FilmAffinity. Sobre cada póster, ficha y lista
aparece un distintivo que dice si esa película o serie ya está en tu Plex, y un
botón para enviarla a Radarr o a Sonarr si no la tienes.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/) en tu navegador.
2. Abre [este enlace](https://raw.githubusercontent.com/ForeverRamone/famonkey/main/famonkey.user.js): Tampermonkey
   reconoce el archivo y ofrece instalarlo. Si prefieres hacerlo a mano, crea un
   script nuevo y pega el contenido de [`famonkey.user.js`](famonkey.user.js).
3. Abre el menú de Tampermonkey en cualquier página de FilmAffinity y elige
   **FA-Monkey: ajustes**.

Instalado así, Tampermonkey avisa por su cuenta cuando hay una versión nueva.

## Configuración

Las claves se introducen en el panel de ajustes del script, no en el código.
Se guardan en el almacenamiento de Tampermonkey.

| Dato | Dónde se obtiene |
|---|---|
| URLs de Plex, Radarr y Sonarr | Las de tu red, con puerto: `http://192.168.1.10:32400`, `http://192.168.1.20:7878`, `http://192.168.1.20:8989` |
| API key de TMDB | themoviedb.org, ajustes de la cuenta, sección API. La **API Key (v3 auth)**, no el "API Read Access Token" |
| X-Plex-Token | En Plex Web, en cualquier elemento: menú ⋮, "Get Info", "View XML". El token va en la URL que se abre |
| API key de Radarr | Radarr, Settings, General, API Key |
| API key de Sonarr | Sonarr, Settings, General, API Key |

Después de pegar cada clave, pulsa **Probar conexión**. En Radarr y Sonarr eso
además rellena los desplegables de perfil de calidad y carpeta raíz, que hay que
elegir antes de poder enviar nada.

No hace falta editar nada más. Las direcciones de tus servicios se ponen en el
panel y el script las usa tal cual, con la IP y el puerto que sean.

## Seguridad

El script solo puede conectarse a TMDB, a la propia web y a las direcciones que
tú hayas configurado. Esa comprobación está en el código, en el único punto por
el que sale una petición, así que tu token de Plex y tus API keys no pueden
acabar en un host ajeno aunque la cabecera declare `@connect *`. Esa declaración
está para que cada uno pueda usar sus propias direcciones sin tocar el código;
la restricción de verdad la impone el script.

## Qué significa cada distintivo

| Aspecto | Significado | Al pulsar |
|---|---|---|
| Ámbar, `▸ PLEX` | Está en tu servidor | Abre la ficha en Plex |
| Verde, `✔` | Descargada en Radarr/Sonarr, aún no visible en Plex | Abre la ficha en Radarr/Sonarr |
| Naranja oscuro, `↓` | Monitorizada, todavía sin archivo; o tienes la serie pero no esa temporada | Abre la ficha en Radarr/Sonarr |
| Azul, `+R` / `+S` | No la tienes | La envía a Radarr o a Sonarr |
| Gris, `?` | TMDB no ha dado una coincidencia fiable | Abre el selector de candidatos |
| Rojo, `!` | Error; el motivo está en el tooltip | Reintenta |

**Mayús+clic** sobre cualquier distintivo abre el selector de candidatos, por si
una coincidencia automática es incorrecta. La elección se guarda para siempre.

## Cómo funciona

Los catálogos de Plex, Radarr y Sonarr se descargan enteros una vez cada seis
horas y se indexan por identificador (`tmdb`, `imdb`, `tvdb`). Navegar no genera
ni una petición a esos servicios: solo se consulta el índice en memoria.

Lo único que se resuelve por título es su identificador de TMDB, y ese dato se
cachea de forma permanente porque no cambia. La primera visita a la portada
gasta unas cuantas búsquedas en TMDB; a partir de la segunda, ninguna.

Para buscar en TMDB no se usa el título en español sino el original, que
FilmAffinity deja al descubierto en el nombre del fichero del póster
(`Cementerio` → `mezarlik`). Cuando la página no muestra el año y quedan varios
candidatos, el script lee la ficha en segundo plano para obtener año y título
original, y reevalúa los candidatos que ya tenía sin repetir las búsquedas.

Película o serie se decide por el marcador que FilmAffinity pone en el título:
`(Serie de TV)` y `(Miniserie de TV)` van a Sonarr; el resto, incluidos los
cortometrajes `(C)` y los telefilmes `(TV)`, a Radarr.

### Series con una ficha por temporada

FilmAffinity abre una ficha distinta para cada temporada: *Euphoria T3*, *Los
Bridgerton T4*, *The White Lotus 3*. Sonarr, en cambio, tiene una sola ficha por
serie con las temporadas dentro, así que el script quita el marcador y busca la
serie: `T3`, `S3` (que es como aparece en el título original), un número suelto
al final, o *Temporada 3*.

Dos detalles que se derivan de eso:

- **El año que muestra FilmAffinity es el de esa temporada**, no el del estreno
  de la serie. *Los Bridgerton T4* pone 2026 y la serie es de 2020. Por eso, en
  series, que el año coincida suma pero que no coincida no resta.
- **Hay temporadas con nombre en vez de número**, como *True Detective: Noche
  polar*, que es la cuarta de *True Detective*. Si el título completo no da con
  nada, se prueba con lo que va delante de los dos puntos.

Cuando una serie se llama de verdad con un número al final, como *Babylon 5*, no
hay problema: el título tal cual se consulta antes que el recortado y tiene
preferencia.

Sabiendo la temporada, el distintivo afina: si tienes la serie en Plex pero
Sonarr dice que esa temporada no tiene ningún episodio, sale en ámbar y el
texto lo aclara, en vez de darte un verde que te haría creer que la tienes.

## Si los distintivos funcionan pero el envío da "tiempo de espera agotado"

Radarr y Sonarr no guardan los metadatos de las películas: los piden a
servidores propios cada vez que buscas o añades algo.

| Servicio | Servidor de metadatos | IP |
|---|---|---|
| Radarr | `api.radarr.video`, `radarr.servarr.com` | `188.114.96.5` (Cloudflare) |
| Sonarr | `skyhook.sonarr.tv` | `104.26.0.163` (Cloudflare) |

En España, las órdenes judiciales de LaLiga hacen que los operadores bloqueen
por IP rangos enteros de Cloudflare durante los partidos, y `188.114.96.0/20`
es uno de los habituales. El bloqueo es un agujero negro: la conexión no se
rechaza, simplemente no contesta nunca, así que Radarr se queda esperando y tu
petición acaba en tiempo de espera agotado.

Que TMDB siga funcionando no es casualidad ni contradice nada: **TMDB no está en
Cloudflare** (usa CloudFront y BunnyCDN), y Letterboxd y FilmAffinity sí lo
están, pero en rangos distintos que no suelen entrar en el bloqueo.

Los distintivos siguen apareciendo bien porque el estado sale de la base de
datos local de Radarr, que no depende de internet. Lo único que se rompe es
añadir películas.

### Comprobarlo

Desde la máquina donde corre Radarr:

```bash
curl -m 5 https://api.radarr.video/v1/movie/603
```

Si se queda colgado y con `curl -m 5 --resolve api.radarr.video:443:104.26.0.163
https://api.radarr.video/v1/movie/603` responde al instante, es este problema.

### Solución

Como el bloqueo es por IP y Cloudflare enruta por SNI, cualquier IP suya no
bloqueada sirve el mismo contenido. Basta con fijarla en el fichero `hosts`
**de la máquina que ejecuta Radarr**, no la del navegador:

```
104.26.0.163 api.radarr.video
104.26.0.163 radarr.servarr.com
```

En Linux es `/etc/hosts`; en Windows, `C:\Windows\System32\drivers\etc\hosts`
como administrador. Si Radarr corre en Docker, en el `docker-compose.yml`:

```yaml
services:
  radarr:
    extra_hosts:
      - "api.radarr.video:104.26.0.163"
      - "radarr.servarr.com:104.26.0.163"
```

No es una solución definitiva: si algún día bloquean también esa IP, busca otra
de Cloudflare que responda y cámbiala. Las alternativas son una VPN en la
máquina de Radarr, o enrutar solo ese dominio por otra salida.

## Menú de Tampermonkey

- **Ajustes**: el panel de configuración.
- **Refrescar índices**: vuelve a leer Plex, Radarr y Sonarr sin esperar a que
  caduquen. Útil después de añadir cosas por otra vía.
- **Borrar caché de coincidencias**: olvida todos los emparejamientos
  FilmAffinity–TMDB, incluidos los elegidos a mano.

## Detalles

- Cambiar el número de peticiones en paralelo requiere recargar la página.
- El script funciona en todo `filmaffinity.com`: portada, fichas, búsquedas,
  rankings, listas de usuario y filmografías.
- Si Plex, Radarr o Sonarr no responden, el script sigue usando el último índice
  bueno que tuviera guardado en lugar de quedarse sin datos.
