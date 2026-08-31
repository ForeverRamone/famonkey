# FA-Monkey

Userscript de Tampermonkey para FilmAffinity. Sobre cada póster, ficha y lista
aparece un distintivo que dice si esa película o serie ya está en tu Plex, y un
botón para enviarla a Radarr o a Sonarr si no la tienes.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/) en tu navegador.
2. Abre el panel de Tampermonkey, elige "Crear un nuevo script", borra la
   plantilla y pega el contenido de [`famonkey.user.js`](famonkey.user.js).
   También puedes arrastrar el archivo a la ventana del navegador.
3. Guarda con Ctrl+S.
4. Abre el menú de Tampermonkey en cualquier página de FilmAffinity y elige
   **FA-Monkey: ajustes**.

## Configuración

Las claves se introducen en el panel de ajustes del script, no en el código.
Se guardan en el almacenamiento de Tampermonkey.

| Dato | Dónde se obtiene |
|---|---|
| API key de TMDB | themoviedb.org, ajustes de la cuenta, sección API. La v3, gratuita |
| X-Plex-Token | En Plex Web, en cualquier elemento: menú ⋮, "Get Info", "View XML". El token va en la URL que se abre |
| API key de Radarr | Radarr, Settings, General, API Key |
| API key de Sonarr | Sonarr, Settings, General, API Key |

Después de pegar cada clave, pulsa **Probar conexión**. En Radarr y Sonarr eso
además rellena los desplegables de perfil de calidad y carpeta raíz, que hay que
elegir antes de poder enviar nada.

Las URLs que trae el script son ejemplos (`192.168.1.10:32400` para Plex,
`192.168.1.20:7878` y `:8989` para Radarr y Sonarr). Pon las tuyas en los
ajustes y, además, **edita las líneas `@connect` de la cabecera del script** con
tus direcciones: Tampermonkey solo deja al script hablar con los hosts que ahí
figuran, y eso es justo lo que impide que tu token de Plex pueda acabar en otro
sitio. Si no las cambias, el script no podrá conectar con tus servicios.

## Qué significa cada distintivo

| Aspecto | Significado | Al pulsar |
|---|---|---|
| Ámbar, `▸ PLEX` | Está en tu servidor | Abre la ficha en Plex |
| Verde, `✔` | Descargada en Radarr/Sonarr, aún no visible en Plex | Abre la ficha en Radarr/Sonarr |
| Naranja oscuro, `↓` | Monitorizada, todavía sin archivo | Abre la ficha en Radarr/Sonarr |
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
