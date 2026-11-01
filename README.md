# 🛎️ Mostrador: el CRM que no deja escapar ventas

**Hackatón DonWeb Day Rosario, 1/11/2026.** Desafío: un negocio local pierde ventas porque atiende consultas y
pedidos a mano, por WhatsApp o por teléfono.

**Demo:** `https://dwday-1252426.online` · **Simulador de WhatsApp:** `https://dwday-1252426.online/whatsapp.html` · **Pedidos por QR:** `https://dwday-1252426.online/pedir.html` · **🎬 Videos paso a paso:** `https://dwday-1252426.online/como-funciona.html`

## ✅ Todo lo que hace, de un vistazo

**Se adapta a cualquier rubro**
- 🧠 **Alta en un minuto:** elegís el rubro y la IA arma el CRM: catálogo, datos que hay que pedirle a cada cliente y cuánto tarda una venta en "enfriarse".
- 📋 **Lista de precios en texto o foto:** la IA la copia tal cual. Si no hay lista, sugiere precios de referencia marcados como "sugerido".
- 🤖 **Bot con personalidad del rubro:** nombre, forma de hablar, jerga y vocabulario (pedido, turno, presupuesto), editables.
- 🎨 **Ícono y color del rubro** en la web, el bot, el simulador y la página del QR.
- 🔄 **Cambiar de rubro** sin perder equipo ni WhatsApp, eligiendo si borrar las ventas y si cargar datos de demo.

**Entran las consultas, por cualquier canal**
- 💬 **WhatsApp con IA:** el bot responde al instante con tus precios, pide lo que falta, resume el pedido con el total y pide el "SÍ".
- 🧪 **Modo MOCK o API real:** simulador de WhatsApp con el mismo formato que Meta para la demo; WhatsApp Cloud API real cargando el token (con firma y verificación de webhook).
- 📱 **Página de pedidos con QR:** el cliente pide solo, a cualquier hora, por texto, foto o audio; cartel imprimible.
- 📥 **Bandeja universal:** mensajes copiados, notas de llamadas, fotos de listas escritas a mano, **capturas de Instagram y WhatsApp** (también con Ctrl+V) y audios (Whisper).
- 📝 **Pasarle al bot:** el empleado anota dos palabras de una llamada y el bot le escribe al cliente por WhatsApp y confirma solo.
- 🚫 **No inventa:** precios calculados por el sistema con el catálogo, datos faltantes como preguntas, mensajes ajenos marcados como "no es venta".

**Ninguna venta se pierde**
- 🗂️ **Embudo:** Nuevo → A confirmar → Confirmado · preparar → Entregado / Perdido (con motivo), con arrastrar y soltar.
- ✅ **Confirmación automática:** cuando el cliente dice "sí", la venta pasa sola a "Confirmado · preparar". Nada se prepara sin confirmar.
- 👥 **Equipo y responsables:** varios usuarios (admin y vendedores); las ventas se reparten solas por carga de trabajo.
- 🔔 **Avisos repetidos:** cada X minutos (configurable) con sonido y notificación del navegador hasta que alguien mueva la venta; si no, **escala al administrador**.
- ⏰ **Recordatorios y notas:** "recordarme en 15 min / 1 h / mañana", notas y reasignación.
- 🕓 **Historial de cada caso:** cada estado, aviso, nota y mensaje en la línea de tiempo del cliente.
- 🚑 **Rescatar venta:** la IA redacta el mensaje de seguimiento con lo pedido y el total, para enviar por WhatsApp o wa.me.

**Ves tus ventas en plata**
- 📊 **Tablero:** plata enfriándose, en juego y ganada, conversión, tiempo de primera respuesta, entradas vs. cierres por día, canales y lo más pedido.
- 🎯 **¿Por dónde empiezo hoy?** La IA prioriza las 3 ventas a atender, con el porqué.
- 🕵️ **Demanda oculta y pérdidas:** lo que te piden y no está en el catálogo, y por qué se pierden las ventas.

**Fácil de usar**
- ❓ **Ayuda en cada sección** con explicación paso a paso y link al video (se puede ocultar).
- 🎬 **9 videos tutoriales** con voz en off rioplatense, cursor animado y logo de DonWeb, generados solos desde la app.
- 🔊 **Escuchar los mensajes** en vez de leerlos (voz de la IA), y lectura automática opcional en la página de pedidos.
- 🌙 **Modo claro / oscuro**, elegido por cada persona.
- 📲 **Funciona en el celular**, online con HTTPS en un Cloud Server de DonWeb.

## 👩‍⚖️ Guía rápida para el jurado (3 minutos)

1. **Abrí https://dwday-1252426.online** — una ferretería ya cargada. Arriba, en rojo: la plata que se está enfriando.
2. **Escribile por WhatsApp:** abrí https://dwday-1252426.online/whatsapp.html en tu celular (o escaneá el QR en *QR y catálogo*), pedí algo ("hola, tienen cemento? quiero 4 bolsas") y respondé "sí" cuando el bot pida confirmar. En el CRM, la venta cae sola en el **Embudo** y pasa a **Confirmado · preparar**.
3. **Bandeja → Probar con un ejemplo** o pegá cualquier mensaje: la IA arma la ficha con los precios del catálogo y dice qué falta preguntar. Probá también un mensaje que no tenga nada que ver.
4. **🤖 Pasarle al bot:** escribí "llamó Ana 341 555 1234, 2 llaves térmicas, retira" y tocá el botón.
5. **Tablero → Preguntarle a la IA:** las 3 ventas a atender primero, con el porqué.
6. **⚙️ Configuración → Cambiar de rubro:** escribí cualquier rubro y la IA adapta catálogo, bot, ícono y color.
7. **Videos de 30-60 s de cada flujo:** https://dwday-1252426.online/como-funciona.html

**Qué mirar en el código:** `server.js` (tipos de ArkType + un prompt con una regla por campo, precios calculados por el sistema y no por la IA, webhook de WhatsApp, avisos con escalamiento) y `public/app.js`.

## El problema, de raíz

En un comercio de barrio las ventas no se pierden por falta de clientes. Se pierden en el camino:

1. **Nadie contesta a tiempo.** El cliente pregunta por WhatsApp, el dueño está atendiendo, y a las 2 horas ya le compró a otro.
2. **Nadie hace el seguimiento.** "Te paso el presupuesto" y después nadie vuelve a escribir.
3. **Nadie sabe cuánta plata se fue.** No hay registro: lo que no se ve no se arregla.

Mostrador ataca las tres cosas.

## Qué hace

| | |
| --- | --- |
| 🧠 **Se adapta a cualquier rubro** | Le decís "ferretería", "rotisería" o "veterinaria" y la IA arma el CRM: catálogo (de tu lista de precios en texto o **foto**), los datos que hay que pedirle a cada cliente y cuánto aguanta un cliente de ese rubro sin respuesta antes de comprarle a otro. |
| 💬 **WhatsApp conectado (MOCK o API real)** | Los mensajes entran por un webhook de WhatsApp Cloud API. En **modo MOCK** (la demo), un simulador de celular manda **el mismo JSON que manda Meta**, así el código que corre es el mismo que en producción. Se cambia desde ⚙️ Configuración. |
| 🤖 **La IA atiende y confirma** | Contesta con **tus** precios, pide lo que falta (medidas, dirección, retiro o envío) y cuando el cliente responde "sí", la venta pasa sola a **Confirmado · a preparar** y se le avisa al responsable. Un pedido no se prepara si no está confirmado. |
| 📝 **Pasarle al bot** | ¿Te llamaron o vino al local? El empleado anota en dos palabras ("llamó Marta 341 555-2190, 3 bolsas de cemento, envío") y el bot arma la venta, le escribe al cliente por WhatsApp para confirmarla y sigue la charla solo. |
| 📥 **Bandeja universal** | Pegá un mensaje, subí la foto de una lista escrita a mano, una **captura de Instagram o WhatsApp** (también con Ctrl+V) o un audio (Whisper). En las capturas, la IA separa los mensajes del cliente de los del negocio y toma el @usuario como cliente. La IA arma la ficha: cliente, productos, total, tipo, urgencia, probabilidad de compra, qué falta preguntar y la próxima acción. |
| 🗂️ **Embudo de ventas** | Nuevo → A confirmar → Confirmado · preparar → Entregado / Perdido (con motivo). Las que se enfrían se ponen en rojo. Arrastrar y soltar. |
| 🔔 **Nadie se olvida** | Cada venta tiene un responsable (se reparten entre el equipo). Mientras no se mueva, le avisa **cada X minutos** (configurable) con sonido y notificación del navegador. Si después de N avisos nadie la movió, **escala al administrador**. "Recordarme en 1 h / mañana". |
| 🚑 **Rescatar venta** | Para una venta que se enfría, la IA escribe el mensaje de seguimiento con lo que pidió y el total, listo para mandar por WhatsApp. |
| 📊 **Tablero en plata** | **Ventas enfriándose ($)**, en juego, ganado, conversión, tiempo de primera respuesta, por canal, lo más pedido, **lo que te piden y no tenés en el catálogo** y por qué se pierden. "¿Por dónde empiezo hoy?": la IA prioriza las 3 ventas a atender. |
| 📱 **QR para el mostrador** | Página de pedidos pública con QR imprimible: el cliente escribe, la IA lo atiende y la venta cae en el embudo. |
| 🕓 **Historial de cada caso** | Cada cambio de estado, aviso, reasignación, nota y mensaje queda en la línea de tiempo del cliente. |

## Cómo usa la IA

- **Modelo de OpenAI con salida estructurada** (JSON Schema estricto), armada y **validada con el mismo tipo de ArkType**
  (`standardResponseFormat` + `chat.completions.parse`). Si la respuesta no cumple el tipo, no entra.
- **Un prompt con una regla por campo.** El primer campo es `analisis`: la IA razona antes de completar el resto.
- **No inventa.** Los precios los pone el sistema con el catálogo del negocio, no la IA. Si falta un dato: `null` y la
  pregunta en `faltaInfo`. Un mensaje que no tiene que ver con el negocio sale como `no_es_venta` y no ensucia el embudo.
- **Confirmación explícita:** `clienteConfirmo` es `true` solo si el cliente acepta un pedido ya detallado.
- **Entrada multimodal:** texto, foto de una lista a mano, captura de un chat de Instagram o WhatsApp (con instrucciones propias para cada una) y audio (Whisper, incluidos los `.opus` de WhatsApp).
- **Caché en SQLite:** repetir la demo no gasta la key. La key vive solo en el servidor.
- **Errores que llegan a la persona:** IA saturada (429), sin crédito, validación fallida: mensajes claros, nunca una pantalla rota.

## WhatsApp: MOCK o API real

En **⚙️ Configuración → Conexión de WhatsApp**:

- **MOCK (demo):** abrí `/whatsapp.html` (o escaneá el QR en "QR y catálogo") y escribile al negocio como cliente.
- **API real (WhatsApp Cloud API):** cargá el token, el Phone Number ID y, opcional, el App Secret (con él se valida la
  firma `X-Hub-Signature-256`). En Meta for Developers, la URL de callback es `https://dwday-1252426.online/webhook/whatsapp`, con el
  verify token que muestra la pantalla, suscripto a `messages`. Los mensajes repetidos (mismo `wamid`) se atienden una sola vez.

## Videos tutoriales

En `/como-funciona.html` hay 9 videos con voz en off (voz masculina, español rioplatense) y el logo de DonWeb:
uno general y uno por flujo (alta y rubro, WhatsApp, pasarle al bot, leer mensajes y capturas, avisos y seguimiento,
tablero, QR y modo MOCK/API real). Se generan solos con `node scripts/videos.mjs`: levanta la app con una base aparte,
la maneja con Chrome (puppeteer-core), saca las capturas con un rótulo por paso, genera la voz con `gpt-4.1-tts`
y arma cada video con ffmpeg.

## Tecnologías y por qué las elegimos

El criterio fue uno solo: **que un comercio de barrio lo pueda usar mañana**. Barato de correr, simple de mantener,
rápido en un celular viejo y sin depender de servicios caros. Y que se pueda deployar en minutos.

| Capa | Tecnología | Por qué |
| --- | --- | --- |
| IA | **OpenAI `gpt-4.1`** con salida estructurada | Lee mensajes desordenados (rioplatense, abreviado, con faltas) y devuelve siempre el mismo JSON. Probamos `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1` y `gpt-5.4-mini` con los mismos mensajes: `gpt-4.1` fue el único que acertó cliente, dirección y forma de entrega en todos los casos, en unos 2 segundos. |
| Validación | **ArkType** + `standardResponseFormat` | Un mismo tipo arma el JSON Schema estricto que va a OpenAI **y** valida la respuesta en el servidor. Si la IA devuelve algo que no cumple, no entra al CRM. Una sola fuente de verdad, sin duplicar esquemas. |
| Voz → texto | **Whisper** (`whisper-1`) | Los clientes mandan audios de WhatsApp: Whisper los transcribe bien en español, incluidos los `.opus`. |
| Voz de los videos | **`gpt-4o-mini-tts`** (voz *onyx*) | Permite indicar acento y tono ("rioplatense con voseo, cálido"), así los tutoriales suenan locales y no a traductor. |
| Servidor | **Node 22 + Hono** | Hono es mínimo y rápido, sirve la API y los archivos con el mismo proceso. Sin paso de build: el deploy es `git pull` y reiniciar. |
| Base de datos | **SQLite** (better-sqlite3) | Un archivo, cero administración, ideal para un comercio. Guardamos cada venta como JSON entero en una columna: el esquema puede cambiar sin migraciones. También sirve de caché de la IA (repetir una demo no gasta la key). |
| Pantalla | **Alpine.js + Pico CSS** | Interactividad sin framework pesado ni compilación: la página carga rápido en cualquier celular. Pico da un diseño prolijo, accesible y con modo oscuro de base. |
| Gráficos | **Chart.js** | Liviano y suficiente para el tablero (embudo, días, canales, productos). |
| QR | **qrcode-generator** | Genera el QR en el navegador, sin depender de un servicio externo. |
| WhatsApp | **WhatsApp Cloud API** (webhook) + simulador | Es la API oficial de Meta. El simulador manda el **mismo JSON** que Meta al mismo webhook, así la demo corre exactamente el código de producción; pasar a real es cargar el token. |
| Hosting | **Cloud Server de DonWeb** (Debian 13) | Servidor propio, en Argentina, con costo fijo y sin vendor lock-in. |
| Procesos y HTTPS | **pm2 + Caddy** | pm2 mantiene la app viva y la levanta si el server se reinicia. Caddy saca y renueva solo el certificado HTTPS (Let's Encrypt), necesario para micrófono, notificaciones y portapapeles. |
| Videos | **puppeteer-core + ffmpeg** | Un script maneja la app real con Chrome, captura cada paso, agrega cursor y voz, y arma los videos. Si la app cambia, los tutoriales se regeneran con un comando. |

**Lo que dejamos afuera a propósito:** frameworks con build (React, Next), bases con servidor (Postgres) y servicios
pagos de terceros. Para este problema sumaban complejidad y costo sin mejorar lo que ve el comerciante.

## Correrlo

```bash
npm ci
cat > .env <<'EOF'
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1
PORT=3000
EOF
npm run dev   # http://localhost:3000
```

Opcional: `WHATSAPP_TOKEN` en el `.env` en vez de cargarlo en la pantalla.

