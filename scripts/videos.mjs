// Genera los videos tutoriales de Mostrador: uno general y uno por cada flujo, paso a paso.
// Levanta la app en el puerto 3100 con una base aparte (video.db), la maneja con Chrome (puppeteer-core),
// le pone a cada captura un rótulo con el logo de DonWeb, genera la voz en off con OpenAI
// (voz masculina, español rioplatense) y arma cada video con ffmpeg.
//
// Uso: node scripts/videos.mjs            (todos)
//      node scripts/videos.mjs whatsapp   (solo algunos, por id)
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import OpenAI from 'openai'

process.chdir(path.join(import.meta.dirname, '..'))
process.loadEnvFile()
const PUERTO = 3100
const BASE = `http://localhost:${PUERTO}`
const TMP = '.video-tmp'
const SALIDA = 'public/video'
const CHROME = process.env.CHROME || ['/usr/sbin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((x) => fs.existsSync(x))
const SOLO = process.argv.slice(2)
const openai = new OpenAI()
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(`${TMP}/tts`, { recursive: true })
fs.mkdirSync(SALIDA, { recursive: true })

// ---------------------------------------------------------------- voz en off
const VOZ = {
  model: 'gpt-4o-mini-tts',
  voice: 'onyx',
  instructions: 'Voz masculina adulta. Español de Argentina, acento rioplatense con voseo ("tenés", "elegís", "mirá"). ' +
    'Tono cálido, seguro y claro, como un tutorial para dueños de comercios. Ritmo natural, ni apurado ni lento.',
}
async function voz(texto) {
  const archivo = `${TMP}/tts/${createHash('sha256').update(JSON.stringify([VOZ, texto])).digest('hex').slice(0, 16)}.mp3`
  if (!fs.existsSync(archivo)) {
    const r = await openai.audio.speech.create({ ...VOZ, input: texto, response_format: 'mp3' })
    fs.writeFileSync(archivo, Buffer.from(await r.arrayBuffer()))
  }
  return archivo
}
const duracion = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())

// ---------------------------------------------------------------- armado con ffmpeg
// Un segmento: la captura, la voz y (si hay) el cursor que viaja de `desde` a `hasta` y hace clic.
function segmento(img, audio, salida, cursor = null) {
  const pausa = 0.35
  const dur = audio ? duracion(audio) + pausa + 0.7 : 2.2
  const entrada = audio ? ['-i', audio] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']
  const af = audio ? `adelay=${pausa * 1000}|${pausa * 1000},apad` : 'apad'
  const base = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:white,setsar=1,fps=30,format=yuv420p'
  const fades = `fade=t=in:st=0:d=0.25,fade=t=out:st=${(dur - 0.25).toFixed(2)}:d=0.25`
  let extra = [], filtro
  if (cursor) {
    // Movimiento suave (smoothstep) de 0.2 s a 1.2 s; el clic (círculo) aparece al llegar.
    const [x0, y0] = cursor.desde, [x1, y1] = cursor.hasta
    const P = 'clip((t-0.2)/1.0\\,0\\,1)'
    const S = `(${P}*${P}*(3-2*${P}))`
    extra = ['-loop', '1', '-i', `${TMP}/cursor.png`, '-loop', '1', '-i', `${TMP}/clic.png`]
    filtro = `[0:v]${base}[b];` +
      `[3:v]format=rgba,scale=iw*'min(1\\,0.4+(t-1.2)*2.2)':-1:eval=frame,fade=t=out:st=1.5:d=0.35:alpha=1[r];` +
      `[b][r]overlay=x=${x1}-w/2:y=${y1}-h/2:enable='between(t\\,1.2\\,1.9)':eval=frame[b2];` +
      `[2:v]format=rgba[c];[b2][c]overlay=x='${x0}+(${x1 - x0})*${S}':y='${y0}+(${y1 - y0})*${S}':eval=frame,${fades}[v]`
  } else filtro = `[0:v]${base},${fades}[v]`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', img, ...entrada, ...extra, '-t', String(dur),
    '-filter_complex', filtro, '-map', '[v]', '-map', '1:a', '-af', af,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '22',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', salida])
}
function armar(id, partes) {
  const dir = `${TMP}/${id}`
  const lista = []
  partes.forEach((p, i) => {
    const seg = `${dir}/seg-${String(i).padStart(2, '0')}.mp4`
    segmento(p.img, p.audio, seg, p.cursor)
    lista.push(`file '${path.resolve(seg)}'`)
  })
  fs.writeFileSync(`${dir}/lista.txt`, lista.join('\n'))
  const mp4 = `${SALIDA}/${id}.mp4`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/lista.txt`, '-c', 'copy', '-movflags', '+faststart', mp4])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', partes[1].img, '-vf', 'scale=960:-1', '-q:v', '4', `${SALIDA}/${id}.jpg`])
  console.log(`✔ ${mp4} (${duracion(mp4).toFixed(0)} s, ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB)`)
}

// ---------------------------------------------------------------- la app
fs.rmSync('video.db', { force: true }); fs.rmSync('video.db-wal', { force: true }); fs.rmSync('video.db-shm', { force: true })
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PUERTO), DB_FILE: 'video.db' }, stdio: ['ignore', 'ignore', 'inherit'] })
process.on('exit', () => server.kill())
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break } catch {} await esperar(200) }

const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 180_000, args: ['--no-sandbox', '--lang=es-AR'] })
async function pagina(url) {
  const p = await navegador.newPage()
  await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 })
  p.on('dialog', (d) => d.accept())
  p.on('pageerror', (e) => console.error('  error en la página:', e.message))
  await p.goto(BASE + url, { waitUntil: 'networkidle2' })
  return p
}
// Corre código con el componente Alpine de la página (`a`).
const alp = (p, codigo, ...args) => p.evaluate(
  new Function('args', `const a = Alpine.$data(document.querySelector('[x-data]')); return (async () => { ${codigo} })()`), args)
const verError = async (p) => { const e = await p.evaluate(() => { try { return Alpine.$data(document.querySelector('[x-data]')).error } catch { return '' } }); if (e) console.error('  ⚠️', e) }

// Rótulo del paso, abajo, con el logo de DonWeb.
async function rotulo(p, n, total, texto) {
  await p.evaluate((n, total, texto) => {
    document.getElementById('rotulo-video')?.remove()
    const r = document.createElement('div')
    r.id = 'rotulo-video'
    r.innerHTML = `<span class="rn">${n}/${total}</span><span class="rt"></span><img src="/img/donweb-marca.jpg" alt="DonWeb">`
    r.querySelector('.rt').textContent = texto
    Object.assign(r.style, { position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: 99999, display: 'flex', alignItems: 'center', gap: '16px',
      padding: '14px 24px', background: 'rgba(20,20,22,.92)', color: '#fff', font: '600 22px Inter, system-ui, sans-serif', boxShadow: '0 -6px 20px #0004' })
    Object.assign(r.querySelector('.rn').style, { background: '#ff6a00', borderRadius: '999px', padding: '4px 14px', fontSize: '18px', flex: 'none' })
    Object.assign(r.querySelector('.rt').style, { flex: '1', lineHeight: '1.25' })
    Object.assign(r.querySelector('img').style, { height: '38px', borderRadius: '6px', flex: 'none' })
    document.body.appendChild(r)
    if (!document.getElementById('rotulo-estilo')) {
      const st = document.createElement('style')
      st.id = 'rotulo-estilo'
      st.textContent = '.toasts { bottom: 90px !important; } .error-flotante { display: none !important; }'
      document.head.appendChild(st)
    }
  }, n, total, texto)
}
async function foto(p, archivo) {
  await esperar(500)
  await p.screenshot({ path: archivo })
  return archivo
}
const subir = (p, y) => p.evaluate((y) => window.scrollTo(0, y), y)
const alElemento = (p, sel, margen = 120) => p.evaluate((sel, margen) => {
  const el = document.querySelector(sel)
  if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - margen)
}, sel, margen)

// ---------------------------------------------------------------- los videos
const LISTA_PRECIOS = `Cemento Loma Negra 50kg 9800
Cal hidratada 25kg 5200
Arena x m3 28000
Taladro percutor Bosch 650W 89000
Tarugos 8mm caja x50 3500
Tornillos 8x40 caja x50 4200
Pintura látex interior 20L 68000
Rodillo lana 22cm 6500
Cable unipolar 2.5mm x m 950
Llave térmica 2x20A 14500
Cinta aisladora 1200
Silicona transparente 4800
Caño PVC 110 x 4m 21000
Disco de corte 115mm 1900`
const capturaInstagram = 'data:image/png;base64,' + fs.readFileSync('scripts/muestras/captura-instagram.png').toString('base64')

// Cada paso: qué se ve (preparar), el rótulo y lo que dice la voz.
const VIDEOS = [
  {
    id: 'general', n: 'Mostrador en 1 minuto', titulo: 'El CRM que no deja escapar ventas', icono: '🛎️',
    sub: 'Qué es, con qué está hecho y cómo fluye una venta',
    voz: 'Mostrador: el CRM que no deja escapar ventas. Te lo explico en un minuto.',
    pasos: [
      { placa: 'p-problema', rotulo: 'Dónde se pierden las ventas',
        voz: 'En un comercio de barrio las ventas no se pierden por falta de clientes. Se pierden porque nadie contesta a tiempo, nadie hace el seguimiento y nadie sabe cuánta plata se fue.' },
      { placa: 'p-tecnologia', rotulo: 'Las tecnologías, en pocas palabras',
        voz: 'Por dentro usa inteligencia artificial de OpenAI con respuestas validadas, Whisper para los audios, la API de WhatsApp, un servidor Node con SQLite, y corre en un Cloud Server de DonWeb.' },
      { placa: 'p-flujo', rotulo: 'El flujo completo de una venta',
        voz: 'El cliente escribe. La inteligencia artificial arma la ficha con tus precios. El bot responde, pide lo que falta y espera el sí. Recién ahí la venta pasa a preparar. Y si una venta se queda quieta, avisa, escala y te ayuda a rescatarla.' },
      { placa: 'p-cierre', rotulo: 'Ninguna venta sin respuesta',
        voz: 'Mostrador. Ninguna venta sin respuesta. En los próximos videos te lo muestro paso a paso.' },
    ],
  },
  {
    id: 'alta-y-rubro', n: 'Paso a paso · 1', titulo: 'Armá tu CRM en un minuto', icono: '🧠', sub: 'Elegís el rubro y la IA adapta todo: catálogo, bot, ícono y color',
    voz: 'Primer paso: armá tu CRM en un minuto.',
    pasos: [
      { rotulo: 'Elegís el rubro, el nombre del negocio y tu equipo',
        voz: 'Mostrador arranca preguntándote qué negocio tenés. Elegís el rubro, escribís el nombre y sumás a tu equipo.' },
      { rotulo: 'Pegás tu lista de precios (o le sacás una foto)',
        voz: 'Si tenés tu lista de precios, la pegás o le sacás una foto. La inteligencia artificial la copia tal cual: los precios no se inventan.' },
      { rotulo: 'Listo: catálogo, ventas y tablero con la plata en juego',
        voz: 'En segundos queda armado tu CRM, con el catálogo, ventas de ejemplo y un tablero que te muestra cuánta plata se está enfriando.' },
      { rotulo: 'Tu asistente tiene nombre, ícono, color y la jerga del rubro',
        voz: 'Cada rubro tiene su asistente. En la ferretería se llama Tornillo y habla como el ferretero del barrio. Podés cambiarle el nombre, el ícono, el color y la forma de hablar.' },
      { rotulo: '¿Otro rubro? La IA adapta todo sin perder tu equipo ni tu WhatsApp',
        voz: '¿Cambiaste de rubro? Lo elegís en Configuración y la inteligencia artificial adapta todo: catálogo, bot, ícono y color. Tu equipo y tu WhatsApp quedan como estaban.' },
      { rotulo: 'Ahora el bot habla como una veterinaria',
        voz: 'Ahora el asistente habla como en una veterinaria: pregunta por la mascota y le dice turno a cada venta.' },
    ],
  },
  {
    id: 'whatsapp', n: 'Paso a paso · 2', titulo: 'Te escriben por WhatsApp', icono: '💬', sub: 'El bot responde con tus precios y confirma el pedido',
    voz: 'Segundo paso: te escriben por WhatsApp.',
    pasos: [
      { rotulo: 'El cliente escribe por WhatsApp (en la demo, con el simulador)',
        voz: 'Así llega un cliente por WhatsApp. En la demo usamos un simulador que manda exactamente el mismo mensaje que la API oficial de Meta.' },
      { rotulo: 'El bot responde al instante, con el precio real de tu catálogo',
        voz: 'El cliente pide cemento y el asistente le contesta al instante, con el precio real de tu catálogo, y le pregunta lo que falta.' },
      { rotulo: 'Resume el pedido con el total y le pide que confirme',
        voz: 'Cuando ya sabe qué lleva y cómo lo recibe, le resume el pedido con el total y le pide que responda sí.' },
      { rotulo: 'El cliente dice que sí',
        voz: 'El cliente confirma, y el asistente le avisa que ya lo empiezan a preparar.' },
      { rotulo: 'En el CRM pasó sola a "Confirmado · preparar", con su historial',
        voz: 'En el CRM la venta pasó sola a confirmado, a preparar, y el responsable recibió el aviso. Nada se prepara sin confirmar.' },
    ],
  },
  {
    id: 'pasar-al-bot', n: 'Paso a paso · 3', titulo: 'Te llamaron: pasáselo al bot', icono: '🤖', sub: 'Anotás dos palabras y el bot sigue por WhatsApp',
    voz: 'Tercer paso: te llamaron por teléfono. Pasáselo al bot.',
    pasos: [
      { rotulo: 'Anotás en dos palabras lo que pidió y su celular',
        voz: '¿Te llamaron o vino alguien al local? Anotás en dos palabras lo que pidió y su celular.' },
      { rotulo: 'El bot arma la venta y le escribe por WhatsApp con el total',
        voz: 'Tocás pasarle al bot. La inteligencia artificial arma la venta y le escribe al cliente por WhatsApp con el detalle y el total.' },
      { rotulo: 'El cliente lo recibe en su WhatsApp y confirma',
        voz: 'El cliente lo recibe en su WhatsApp y contesta que sí.' },
      { rotulo: 'Confirmada, con todo el caso en el historial',
        voz: 'La venta queda confirmada, y todo el caso queda en el historial: quién la tomó, qué se dijo y cada cambio de estado.' },
    ],
  },
  {
    id: 'leer-mensajes', n: 'Paso a paso · 4', titulo: 'Leé cualquier mensaje', icono: '📥', sub: 'Texto, captura de Instagram, foto de una lista o audio',
    voz: 'Cuarto paso: leé cualquier mensaje.',
    pasos: [
      { rotulo: 'Pegás el mensaje y la IA arma la ficha con tus precios',
        voz: 'Si te escriben por otro lado, pegás el mensaje y la inteligencia artificial arma la ficha: quién es, qué quiere, el total con tus precios y qué falta preguntarle.' },
      { rotulo: 'También lee capturas de Instagram (subís o pegás la imagen)',
        voz: 'También lee capturas de Instagram. Subís la captura del chat, o la pegás con control ve.' },
      { rotulo: 'Separa lo que dijo el cliente, toma su usuario y arma el pedido',
        voz: 'La inteligencia artificial separa lo que dijo el cliente de lo que contestó el negocio, toma su usuario, el teléfono y la dirección, y arma el pedido.' },
      { rotulo: 'Si no tiene nada que ver con el negocio, no inventa',
        voz: 'Y si el mensaje no tiene nada que ver con el negocio, lo marca como que no es una venta. No inventa.' },
    ],
  },
  {
    id: 'avisos-y-seguimiento', n: 'Paso a paso · 5', titulo: 'Ninguna venta se olvida', icono: '🔔', sub: 'Responsables, avisos, escalamiento, rescate e historial',
    voz: 'Quinto paso: ninguna venta se olvida.',
    pasos: [
      { rotulo: 'El embudo: las ventas que se enfrían se ponen en rojo',
        voz: 'En el embudo ves cada venta por etapa. Las que esperan demasiado se ponen en rojo: es plata que se está enfriando.' },
      { rotulo: 'Configurás cada cuánto avisar, cuándo escalar y quién es tu equipo',
        voz: 'Configurás cada cuántos minutos avisar, después de cuántos avisos escalar al administrador, y quién es tu equipo. Las ventas se reparten solas.' },
      { rotulo: 'El responsable recibe avisos con sonido hasta que la atienda',
        voz: 'Si nadie mueve una venta, el responsable recibe un aviso con sonido y notificación, una y otra vez, hasta que la atienda.' },
      { rotulo: 'Rescatar venta: la IA escribe el mensaje de seguimiento',
        voz: 'Para rescatar una venta, la inteligencia artificial escribe el mensaje de seguimiento con lo que pidió y el total, listo para mandar por WhatsApp.' },
      { rotulo: 'Notas, recordatorios y el historial completo del cliente',
        voz: 'Podés reasignarla, agendar un recordatorio o dejar una nota. Cada paso queda en el historial del cliente.' },
    ],
  },
  {
    id: 'tablero', n: 'Paso a paso · 6', titulo: 'Tus ventas, en plata', icono: '📊', sub: 'El tablero y las prioridades del día',
    voz: 'Sexto paso: tus ventas, en plata.',
    pasos: [
      { rotulo: 'Plata enfriándose, en juego, ganada y tiempo de respuesta',
        voz: 'El tablero muestra lo que importa: cuánta plata se está enfriando, cuánta hay en juego, cuánto ganaste y cuánto tardás en responder.' },
      { rotulo: '¿Por dónde empiezo hoy? La IA prioriza las 3 ventas clave',
        voz: 'Y la inteligencia artificial te dice por dónde empezar el día: las tres ventas que más conviene atender ahora, con el porqué.' },
      { rotulo: 'Qué entra, qué se cierra, por dónde llegan y qué se vende',
        voz: 'Ves qué entra y qué se cierra cada día, por qué canal llegan los clientes y qué es lo más pedido.' },
      { rotulo: 'Lo que te piden y no tenés, y por qué se pierden las ventas',
        voz: 'Y también lo que te piden y no tenés en el catálogo, y por qué se pierden las ventas.' },
    ],
  },
  {
    id: 'qr', n: 'Paso a paso · 7', titulo: 'Tu QR de pedidos', icono: '📱', sub: 'Pedidos las 24 horas, directo al embudo',
    voz: 'Séptimo paso: tu QR de pedidos.',
    pasos: [
      { rotulo: 'Imprimís el cartel con tu QR o compartís el link',
        voz: 'Imprimís el cartel con tu QR y lo pegás en el mostrador, o compartís el link en Instagram.' },
      { rotulo: 'El cliente escanea y el asistente lo atiende con tus precios',
        voz: 'El cliente escanea, escribe lo que necesita, y el asistente lo atiende con tus precios, a cualquier hora.' },
      { rotulo: 'Cada pedido del QR cae solo en el embudo',
        voz: 'Cada pedido que entra por el QR cae solo en el embudo, con su responsable y sus avisos.' },
    ],
  },
  {
    id: 'whatsapp-config', n: 'Paso a paso · 8', titulo: 'WhatsApp: demo o API real', icono: '⚙️', sub: 'Se elige desde Configuración',
    voz: 'Octavo paso: cómo se conecta WhatsApp.',
    pasos: [
      { rotulo: 'Modo MOCK: la demo funciona con el simulador de WhatsApp',
        voz: 'En Configuración elegís cómo se conecta WhatsApp. En modo demo, todo funciona con el simulador.' },
      { rotulo: 'API real: token y número de WhatsApp Business de Meta',
        voz: 'Para usarlo de verdad, elegís API real y cargás el token y el número de WhatsApp Business. El código es el mismo: solo cambia de dónde llegan los mensajes.' },
    ],
  },
]

// ---------------------------------------------------------------- a dónde apunta el cursor en cada paso
const APUNTAR = {
  'alta-y-rubro': ['.chip.activo', 'details textarea', '.kpi.riesgo', '.bot-tarjeta', '.rubro-config button.contrast', '.bot-tarjeta'],
  whatsapp: ['.pie input[type=text]', '.msg.negocio@ultimo', '.msg.negocio@ultimo', '.msg.cliente@ultimo', '.etapas button.activa'],
  'pasar-al-bot': ['button.bot', 'dialog .chat .burbuja.negocio@ultimo', '.msg.cliente@ultimo', '.linea-tiempo li'],
  'leer-mensajes': ['.ficha table.items', '#muestra-captura img', '.ficha input', '.ficha .etiqueta'],
  'avisos-y-seguimiento': ['.tarjeta.riesgo', '.wa-config + article input.corto', '.avisos li', 'dialog textarea', '.linea-tiempo li'],
  tablero: ['.kpi.riesgo', '.prioridades ol li', '#gDias', '.graficos + .dos article'],
  qr: ['#qr', '.resumen', '.columna.nuevo .tarjeta'],
  'whatsapp-config': ['.wa-config fieldset label', '.wa-config input[type=password]'],
}
const posCursor = {}   // última posición del cursor en cada video

// Resalta el elemento con un borde naranja y devuelve su centro en píxeles del video (1920×1080).
async function marcar(p, selector) {
  if (!selector) return null
  const [sel, cual] = selector.split('@')
  return p.evaluate((sel, cual) => {
    const todos = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length)
    const el = cual === 'ultimo' ? todos.at(-1) : todos[0]
    if (!el) return null
    el.style.outline = '3px solid #ff6a00'
    el.style.outlineOffset = '3px'
    el.style.borderRadius ||= '6px'
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 160), 20), innerWidth - 20)
    const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 40), 20), innerHeight - 90)
    return [Math.round(x * 1.5), Math.round(y * 1.5)]
  }, sel, cual)
}

// ---------------------------------------------------------------- capturas
const capturas = {}   // id → [archivo por paso]
const guardar = (id, i, archivo) => { (capturas[id] ??= [])[i] = archivo }
const dir = (id) => { fs.mkdirSync(`${TMP}/${id}`, { recursive: true }); return `${TMP}/${id}` }
const quiero = (id) => !SOLO.length || SOLO.includes(id)
const total = (id) => VIDEOS.find((v) => v.id === id).pasos.length
async function paso(p, id, i, { avisos = false } = {}) {
  const v = VIDEOS.find((x) => x.id === id)
  await verError(p)
  if (!avisos) await p.evaluate(() => { try { Alpine.$data(document.querySelector('[x-data]')).toasts = [] } catch {} })
  await rotulo(p, i + 1, total(id), v.pasos[i].rotulo)
  const hasta = await marcar(p, APUNTAR[id]?.[i])
  guardar(id, i, await foto(p, `${dir(id)}/paso-${i}.png`))
  if (hasta) {
    cursores[id] ??= []
    cursores[id][i] = { desde: posCursor[id] || [960, 980], hasta }
    posCursor[id] = hasta
  }
  // Saca el resaltado para la próxima captura.
  await p.evaluate(() => document.querySelectorAll('[style*="outline"]').forEach((e) => { e.style.outline = ''; e.style.outlineOffset = '' }))
}
const cursores = {}
// El detalle de una venta es un <dialog> con su propio scroll: para ver el historial hay que bajarlo.
const alFinalDelDetalle = (p) => p.evaluate(() => document.querySelectorAll('dialog, dialog article').forEach((d) => { d.scrollTop = d.scrollHeight }))
const tel = (n) => n

console.log('Capturando…')
const P = await pagina('/')

// 1. Alta (base vacía)
await alp(P, `a.elegirRubro(a.RUBROS[0]); a.alta.admin = 'Vero'; a.alta.equipo = 'Lucas, Sofi'`)
await paso(P, 'alta-y-rubro', 0)
await alp(P, `a.alta.listaPrecios = args[0]; document.querySelector('details').open = true`, LISTA_PRECIOS)
await alElemento(P, 'details', 260)
await paso(P, 'alta-y-rubro', 1)
await alp(P, `await a.crearNegocio()`)
await P.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()))
await alp(P, `a.toasts = []`)
await subir(P, 0)
await paso(P, 'alta-y-rubro', 2)
await alp(P, `a.irA('equipo'); a.config.color = '#c2410c'; await a.guardarConfig()`)
await alElemento(P, '.rubro-config')
await paso(P, 'alta-y-rubro', 3)

// 2. WhatsApp
const W = await pagina('/whatsapp.html')
const wa = (codigo, ...args) => alp(W, codigo, ...args)
await wa(`a.nombre = 'Julián Paz'; a.telefono = '5493415559876'; a.entrar()`)
await paso(W, 'whatsapp', 0)
await wa(`a.texto = 'hola! tienen cemento? necesito 4 bolsas'; await a.enviarTexto()`)
await paso(W, 'whatsapp', 1)
await wa(`a.texto = 'lo paso a buscar hoy a la tarde, soy julian'; await a.enviarTexto()`)
await paso(W, 'whatsapp', 2)
await wa(`a.texto = 'si dale, confirmo'; await a.enviarTexto()`)
await paso(W, 'whatsapp', 3)
await alp(P, `await a.refrescar(); a.irA('embudo'); const o = a.ops.find((x) => x.telefono === '5493415559876'); if (o) a.abrir(o)`)
await paso(P, 'whatsapp', 4)
await alp(P, `a.sel = null`)

// 3. Pasarle al bot
await alp(P, `a.irA('bandeja'); a.ficha = null; a.texto = 'llamó Raúl Medina 341 655 0099, quiere 2 llaves térmicas y 20 metros de cable 2.5, pasa a retirar'`)
await alElemento(P, '.dos')
await paso(P, 'pasar-al-bot', 0)
await alp(P, `await a.pasarAlBot()`)
await paso(P, 'pasar-al-bot', 1)
await wa(`a.salir(); a.nombre = 'Raúl'; a.telefono = '5493416550099'; a.entrar(); await new Promise((r) => setTimeout(r, 300)); await a.cargar()`)
await wa(`a.texto = 'Sí, confirmo. Paso a la tarde'; await a.enviarTexto()`)
await paso(W, 'pasar-al-bot', 2)
await alp(P, `await a.refrescar(); const o = a.ops.find((x) => x.telefono === '3416550099' || x.telefono === '5493416550099'); if (o) a.abrir(o)`)
await alFinalDelDetalle(P)
await paso(P, 'pasar-al-bot', 3)
await alp(P, `a.sel = null`)

// 4. Leer mensajes
await alp(P, `a.irA('bandeja'); a.canal = 'whatsapp'; await a.usarEjemplo()`)
await alElemento(P, '.dos')
await paso(P, 'leer-mensajes', 0)
await P.evaluate((src) => {
  const d = document.createElement('div')
  d.id = 'muestra-captura'
  Object.assign(d.style, { position: 'fixed', inset: '0', zIndex: 9999, background: 'linear-gradient(45deg,#f09433,#dc2743 50%,#bc1888)', display: 'grid', placeItems: 'center' })
  d.innerHTML = `<img src="${src}" style="height:78vh;border-radius:18px;box-shadow:0 20px 60px #0006">`
  document.body.appendChild(d)
}, capturaInstagram)
await paso(P, 'leer-mensajes', 1)
await P.evaluate(() => document.getElementById('muestra-captura')?.remove())
await alp(P, `const b = await (await fetch(args[0])).blob(); await a.leerImagen(new File([b], 'captura.png', { type: 'image/png' }), 'captura_instagram'); a.toasts = []`, capturaInstagram)
await alElemento(P, '.dos')
await paso(P, 'leer-mensajes', 2)
await alp(P, `a.texto = 'jajaja viste el partido de anoche? central la rompió'; await a.leer()`)
await paso(P, 'leer-mensajes', 3)
await alp(P, `a.ficha = null; a.texto = ''`)

// 5. Avisos y seguimiento
await alp(P, `await a.refrescar(); a.irA('embudo')`)
await alElemento(P, '.kanban', 130)
await paso(P, 'avisos-y-seguimiento', 0)
await alp(P, `a.irA('equipo')`)
await alElemento(P, '.wa-config + article', 120)
await paso(P, 'avisos-y-seguimiento', 1)
await alp(P, `await a.revisarAvisos(true); a.irA('equipo'); a.toasts = []; if (a.avisos[0]) a.toast('⏰ ' + a.avisos[0].texto, 'alerta')`)
await subir(P, 0)
await alElemento(P, '.pestanas', 110)
await paso(P, 'avisos-y-seguimiento', 2, { avisos: true })
await alp(P, `a.toasts = []; const o = a.ops.find((x) => x.enRiesgo && x.telefono) || a.ops.find((x) => x.enRiesgo); a.abrir(o); await a.redactar(o, 'rescate')`)
await paso(P, 'avisos-y-seguimiento', 3)
await alp(P, `a.nota = 'Lo llamé y no atendió, le mando el WhatsApp'; await a.agregarNota(a.sel); await a.posponer(a.sel, 60); a.toasts = []`)
await alFinalDelDetalle(P)
await paso(P, 'avisos-y-seguimiento', 4)
await alp(P, `a.sel = null; a.borrador = null`)

// 6. Tablero
await alp(P, `a.irA('tablero')`)
await subir(P, 0)
await esperar(1200)
await paso(P, 'tablero', 0)
await alp(P, `await a.pedirPrioridades()`)
await alElemento(P, '.prioridades', 110)
await paso(P, 'tablero', 1)
await alElemento(P, '.graficos', 110)
await esperar(800)
await paso(P, 'tablero', 2)
await alElemento(P, '.graficos + .dos', 300)
await paso(P, 'tablero', 3)

// 7. QR
await alp(P, `a.irA('negocio')`)
await subir(P, 0)
await alElemento(P, '.pestanas', 110)
await esperar(500)
await paso(P, 'qr', 0)
const Q = await pagina('/pedir.html')
await alp(Q, `a.texto = 'hola! quiero 2 cajas de tornillos 8x40 y una de tarugos del 8'; await a.mandarTexto()`)
await alp(Q, `a.texto = 'retiro yo, soy Paula, mi cel 341 603 7788'; await a.mandarTexto()`)
await paso(Q, 'qr', 1)
await alp(P, `await a.refrescar(); a.irA('embudo')`)
await alElemento(P, '.kanban', 130)
await paso(P, 'qr', 2)

// 8. Configuración de WhatsApp
await alp(P, `a.irA('equipo'); a.toasts = []`)
await alElemento(P, '.wa-config', 120)
await paso(P, 'whatsapp-config', 0)
await alp(P, `a.config.whatsapp.modo = 'real'`)
await paso(P, 'whatsapp-config', 1)
await alp(P, `a.config.whatsapp.modo = 'mock'`)

// 1 (final). Cambio de rubro
await alp(P, `a.irA('equipo'); a.nuevoRubro = { rubro: 'Veterinaria y pet shop', nombre: 'Veterinaria Patitas', ciudad: '', listaPrecios: '', borrarVentas: true, conEjemplos: true }`)
await alElemento(P, '.rubro-config h6', 200)
await paso(P, 'alta-y-rubro', 4)
await alp(P, `await a.cambiarRubroIA()`)
await subir(P, 0)
await alElemento(P, '.rubro-config', 120)
await paso(P, 'alta-y-rubro', 5)

// El cursor y el círculo del clic, como PNG transparentes.
const C = await navegador.newPage()
await C.setViewport({ width: 60, height: 60, deviceScaleFactor: 1.5 })
await C.setContent(`<body style="margin:0;background:transparent"><svg width="40" height="48" viewBox="0 0 20 24" style="filter:drop-shadow(1px 2px 2px #0007)">
  <path d="M1 1 L1 19 L6 14.5 L9.5 22 L12.5 20.7 L9 13.5 L15.5 13.5 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></body>`)
await C.screenshot({ path: `${TMP}/cursor.png`, omitBackground: true, clip: { x: 0, y: 0, width: 32, height: 40 } })
await C.setViewport({ width: 90, height: 90, deviceScaleFactor: 1.5 })
await C.setContent(`<body style="margin:0;background:transparent"><div style="width:80px;height:80px;margin:5px;border-radius:50%;border:5px solid #ff6a00;background:rgba(255,106,0,.25);box-sizing:border-box"></div></body>`)
await C.screenshot({ path: `${TMP}/clic.png`, omitBackground: true })
await C.close()

// Placas (títulos y video general)
const PL = await pagina('/placas.html')
async function placa(url, archivo) {
  await PL.goto(BASE + url, { waitUntil: 'networkidle2' })
  return foto(PL, archivo)
}
for (const v of VIDEOS) {
  const q = new URLSearchParams({ p: 'p-titulo', titulo: v.titulo, sub: v.sub, n: v.n, icono: v.icono })
  v.portada = await placa('/placas.html?' + q, `${dir(v.id)}/portada.png`)
}
for (const [i, s] of VIDEOS[0].pasos.entries()) guardar('general', i, await placa(`/placas.html?p=${s.placa}`, `${dir('general')}/paso-${i}.png`))
await navegador.close()

// ---------------------------------------------------------------- voz y armado
console.log('Voz y armado…')
const resumen = []
for (const v of VIDEOS) {
  if (!quiero(v.id)) continue
  const partes = [{ img: 'public/img/donweb.jpg' }, { img: v.portada, audio: await voz(v.voz) }]
  for (const [i, s] of v.pasos.entries()) partes.push({ img: capturas[v.id][i], audio: await voz(s.voz), cursor: cursores[v.id]?.[i] })
  partes.push({ img: 'public/img/donweb.jpg' })
  armar(v.id, partes)
  resumen.push({ id: v.id, n: v.n, titulo: v.titulo, sub: v.sub, icono: v.icono, pasos: v.pasos.map((s) => s.rotulo) })
}
if (!SOLO.length) fs.writeFileSync(`${SALIDA}/videos.json`, JSON.stringify(resumen, null, 2))
server.kill()
process.exit(0)
