# 🛎️ Mostrador: el CRM que no deja escapar ventas

**Hackatón DonWeb Day Rosario, 1/11/2026.** Desafío: un negocio local pierde ventas porque atiende consultas y
pedidos a mano, por WhatsApp o por teléfono.

**Demo:** `https://[URL]` · **Simulador de WhatsApp:** `https://[URL]/whatsapp.html` · **Pedidos por QR:** `https://[URL]/pedir.html` · **🎬 Videos paso a paso:** `https://[URL]/como-funciona.html`

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
  firma `X-Hub-Signature-256`). En Meta for Developers, la URL de callback es `https://[URL]/webhook/whatsapp`, con el
  verify token que muestra la pantalla, suscripto a `messages`. Los mensajes repetidos (mismo `wamid`) se atienden una sola vez.

## Videos tutoriales

En `/como-funciona.html` hay 9 videos con voz en off (voz masculina, español rioplatense) y el logo de DonWeb:
uno general y uno por flujo (alta y rubro, WhatsApp, pasarle al bot, leer mensajes y capturas, avisos y seguimiento,
tablero, QR y modo MOCK/API real). Se generan solos con `node scripts/videos.mjs`: levanta la app con una base aparte,
la maneja con Chrome (puppeteer-core), saca las capturas con un rótulo por paso, genera la voz con `gpt-4o-mini-tts`
y arma cada video con ffmpeg.

## Stack

Node 22 + Hono, better-sqlite3, SDK oficial de OpenAI + ArkType, Alpine.js + Pico CSS + Chart.js (sin build).
Deploy: Cloud Server de DonWeb con pm2 y Caddy (HTTPS).

## Correrlo

```bash
npm ci
cat > .env <<'EOF'
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
PORT=3000
EOF
npm run dev   # http://localhost:3000
```

Opcional: `WHATSAPP_TOKEN` en el `.env` en vez de cargarlo en la pantalla.

## Qué haría con más tiempo

- Login por usuario y permisos (hoy se elige "quién soy" arriba a la derecha).
- Notificaciones push con la app cerrada (Web Push) y aviso por WhatsApp al empleado.
- Plantillas de WhatsApp aprobadas para escribir fuera de la ventana de 24 h.
- Stock real y cobro con link de pago al confirmar.
