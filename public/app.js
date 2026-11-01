// Mostrador: el panel del negocio. Alpine para la pantalla; Chart.js y el QR afuera de Alpine
// (Alpine envuelve sus datos en un Proxy y esas librerías fallan).
let graficos = {}

const RUBROS = [
  { emoji: '🔧', rubro: 'Ferretería', nombre: 'Ferretería El Tornillo' },
  { emoji: '🍗', rubro: 'Rotisería', nombre: 'Rotisería Doña Rosa' },
  { emoji: '🐶', rubro: 'Veterinaria y pet shop', nombre: 'Veterinaria Patitas' },
  { emoji: '🛒', rubro: 'Almacén y despensa', nombre: 'Almacén Don Pepe' },
  { emoji: '🚗', rubro: 'Taller mecánico', nombre: 'Taller Los Hermanos' },
  { emoji: '💐', rubro: 'Florería', nombre: 'Florería Primavera' },
]
const ETAPAS = [
  { id: 'nuevo', nombre: 'Nuevo', icono: '🆕' },
  { id: 'respondido', nombre: 'A confirmar', icono: '⏳' },
  { id: 'confirmado', nombre: 'Confirmado · preparar', icono: '✅' },
  { id: 'entregado', nombre: 'Entregado', icono: '📦' },
  { id: 'perdido', nombre: 'Perdido', icono: '💔' },
]
const PESTANAS = [
  { id: 'bandeja', nombre: 'Bandeja', icono: '📥' },
  { id: 'embudo', nombre: 'Embudo', icono: '🗂️' },
  { id: 'tablero', nombre: 'Tablero', icono: '📊' },
  { id: 'equipo', nombre: 'Configuración y avisos', icono: '⚙️' },
  { id: 'negocio', nombre: 'QR y catálogo', icono: '🏪' },
  { id: 'ia', nombre: 'Cómo usa la IA', icono: '🧠' },
]
const ICONO_CANAL = { whatsapp: '🟢', telefono: '📞', web: '🌐', mostrador: '🏪', instagram: '📸' }
const TIPOS = { pedido: '🛍️ pedido', presupuesto: '🧾 presupuesto', consulta: '❔ consulta', reclamo: '⚠️ reclamo', no_es_venta: '🚫 no es venta' }
const MOTIVOS = ['Le respondimos tarde', 'Precio', 'No teníamos stock', 'Compró en otro lado', 'Dejó de responder', 'Otro']

const COMO_USA_IA = `
<h3>🧠 Cómo usa la IA</h3>
<p><a href="como-funciona.html" target="_blank" rel="noopener">▶️ Ver el video y el flujo completo, paso a paso</a></p>
<div class="grid-ia">
  <div><b>1. Se adapta a tu rubro.</b> Le decís "ferretería" o "rotisería" y arma el catálogo (con tu lista de precios, en texto o foto), los datos que hay que pedirle a cada cliente y cuántas horas aguanta un cliente de ese rubro antes de comprarle a otro.</div>
  <div><b>2. Lee cualquier mensaje.</b> Texto de WhatsApp, la nota de una llamada, una captura de un chat de Instagram, la foto de una lista escrita a mano o un audio (Whisper lo pasa a texto). Devuelve una ficha <b>estructurada y validada</b> con ArkType: cliente, productos, tipo, urgencia, probabilidad de compra y próxima acción.</div>
  <div><b>3. No inventa.</b> Los precios salen de <i>tu</i> catálogo, no de la IA. Si falta un dato, lo deja vacío y escribe la pregunta para hacerle al cliente. Si el mensaje no tiene que ver con el negocio, lo marca como "no es venta".</div>
  <div><b>4. Atiende 24/7 por el QR.</b> El cliente escribe en tu página de pedidos, la IA le contesta con tus precios y la venta cae sola en el embudo, asignada a alguien del equipo.</div>
  <div><b>5. Rescata ventas.</b> Si una venta se enfría, redacta el mensaje de seguimiento con lo que pidió y el total, listo para mandar por WhatsApp. Y te dice por cuáles ventas empezar el día.</div>
  <div><b>6. Nadie se olvida.</b> Cada venta abierta le avisa a su responsable cada X minutos (sonido + notificación) hasta que alguien la mueva, y si no, escala al administrador.</div>
</div>
<p><small>Modelo de OpenAI con salida estructurada (JSON Schema estricto) validada en el servidor con el mismo tipo. Las respuestas se guardan en caché: repetir una demo no gasta la key. La key vive solo en el servidor.</small></p>`

// Si la respuesta no es 2xx, tira un error con el mensaje del server.
async function revisar(r) {
  if (r.ok) return r
  const { error } = await r.json().catch(() => ({}))
  throw new Error(error || `El servidor respondió ${r.status}.`)
}
const api = async (url, opciones) => (await revisar(await fetch(url, opciones))).json()
const enviarJSON = (metodo, url, datos) =>
  api(url, { method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(datos) })

async function achicarImagen(archivo, lado = 1280) {
  const imagen = await createImageBitmap(archivo)
  const escala = Math.min(1, lado / Math.max(imagen.width, imagen.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(imagen.width * escala)
  canvas.height = Math.round(imagen.height * escala)
  canvas.getContext('2d').drawImage(imagen, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

// Personalidad visual del rubro: color principal, favicon con el ícono del rubro y título de la pestaña.
function oscurecer(hex, k = 0.55) {
  const n = parseInt(hex.slice(1), 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}
function aplicarTema(negocio) {
  const raiz = document.documentElement.style
  const color = /^#[0-9a-f]{6}$/i.test(negocio?.color || '') ? negocio.color : '#0b6e4f'
  for (const v of ['--pico-primary', '--pico-primary-background', '--pico-primary-border']) raiz.setProperty(v, color)
  for (const v of ['--pico-primary-hover', '--pico-primary-hover-background', '--pico-primary-hover-border']) raiz.setProperty(v, oscurecer(color, 0.8))
  raiz.setProperty('--color-rubro', color)
  raiz.setProperty('--color-rubro-oscuro', oscurecer(color))
  raiz.setProperty('--pico-primary-focus', color + '40')
  const emoji = negocio?.emoji || '🛎️'
  let icono = document.querySelector('link[rel=icon]')
  icono.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${encodeURIComponent(emoji)}</text></svg>`
  document.title = negocio ? `${emoji} ${negocio.nombre} · Mostrador` : 'Mostrador · el CRM que no deja escapar ventas'
}

const leerLocal = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def } catch { return def } }
const guardarLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

// Un "ding" corto sin archivos de audio.
function sonar() {
  try {
    const ctx = new AudioContext()
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.15)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + i * 0.15); o.stop(ctx.currentTime + i * 0.15 + 0.3)
    }
  } catch {}
}

function linkWa(telefono, texto) {
  let d = String(telefono || '').replace(/\D/g, '')
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '549' + d
  return `https://wa.me/${d.length >= 11 ? d : ''}?text=${encodeURIComponent(texto || '')}`
}

const AZUL = '#0172ad', VERDE = '#2e7d32', ROJO = '#c62828', GRIS = '#90a4ae', NARANJA = '#ef6c00'
function grafico(id, config) {
  const el = document.getElementById(id)
  if (!el) return
  if (graficos[id]) { graficos[id].data = config.data; graficos[id].update(); return }
  graficos[id] = new Chart(el, { ...config, options: { maintainAspectRatio: false, plugins: { legend: { display: config.leyenda ?? false } }, ...config.options } })
}
function dibujarGraficos(t) {
  if (!t) return
  const pesos = (v) => '$' + Math.round(v).toLocaleString('es-AR')
  grafico('gEtapas', {
    type: 'bar',
    data: { labels: t.porEtapa.map((e) => e.etapa), datasets: [{ data: t.porEtapa.map((e) => e.monto), backgroundColor: [AZUL, AZUL, VERDE, VERDE, ROJO] }] },
    options: { scales: { y: { ticks: { callback: pesos } } } },
  })
  grafico('gDias', {
    type: 'line', leyenda: true,
    data: {
      labels: t.porDia.map((d) => new Date(d.dia + 'T12:00').toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' })),
      datasets: [
        { label: 'Entran', data: t.porDia.map((d) => d.entrantes), borderColor: AZUL, backgroundColor: AZUL, tension: 0.3 },
        { label: 'Se cierran', data: t.porDia.map((d) => d.ganadas), borderColor: VERDE, backgroundColor: VERDE, tension: 0.3 },
      ],
    },
    options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  })
  grafico('gCanales', {
    type: 'doughnut', leyenda: true,
    data: { labels: t.porCanal.map((c) => c.canal), datasets: [{ data: t.porCanal.map((c) => c.cantidad), backgroundColor: [VERDE, AZUL, NARANJA, GRIS, '#8e24aa'] }] },
  })
  grafico('gProductos', {
    type: 'bar',
    data: { labels: t.topProductos.map((p) => p.producto), datasets: [{ data: t.topProductos.map((p) => p.pedidos), backgroundColor: AZUL }] },
    options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  })
}

function dibujarQR(url, id = 'qr') {
  const el = document.getElementById(id)
  if (!el || typeof qrcode === 'undefined') return
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })
}

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    RUBROS, ETAPAS, PESTANAS, ICONO_CANAL, TIPOS, COMO_USA_IA, linkWa,
    cargado: false, negocio: null, config: null, tablero: null, ops: [],
    pestana: leerLocal('pestana', 'bandeja'), yo: leerLocal('yo', 1),
    alta: { rubro: '', nombre: '', ciudad: 'Rosario', admin: '', equipo: '', listaPrecios: '', imagen: null, conEjemplos: true },
    canal: 'whatsapp', texto: '', ficha: null, ejemplo: 0,
    soloMias: false, soloRiesgo: false, buscar: '', arrastrando: null,
    sel: null, borrador: null, nota: '', prioridades: null,
    avisos: [], ultimoAviso: 0, avisosSinLeer: 0, permisoNotif: typeof Notification === 'undefined' ? 'no' : Notification.permission,
    toasts: [], error: '',
    ocupado: false, guardando: false, redactando: false, pensando: false, grabando: false,

    async init() {
      await this.intentar('ocupado', async () => {
        this.negocio = await api('/api/negocio')
        if (this.negocio) await this.alArrancar()
      })
      this.cargado = true
      setInterval(() => this.negocio && this.refrescar(true).catch(() => {}), 10_000)
      setInterval(() => this.negocio && this.revisarAvisos().catch(() => {}), 15_000)
    },

    async alArrancar() {
      aplicarTema(this.negocio)
      if (!this.negocio.usuarios.some((u) => u.id === this.yo)) this.yo = this.negocio.usuarios[0].id
      this.config = JSON.parse(JSON.stringify(this.negocio))
      this.config.whatsapp ??= { modo: 'mock', autoResponder: true, token: null, phoneNumberId: null, verifyToken: '', appSecret: null }
      await this.refrescar()
      this.ultimoAviso = leerLocal('ultimoAviso:' + this.yo, 0)
      await this.revisarAvisos()
      this.irA(this.pestana)
    },

    async intentar(bandera, accion) {
      this[bandera] = true
      this.error = ''
      try { return await accion() } catch (err) { this.error = err.message } finally { this[bandera] = false }
    },

    // ---------- formatos ----------
    pesos: (v) => v ? '$' + Math.round(v).toLocaleString('es-AR') : '$0',
    minutos: (m) => m == null ? '—' : m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`,
    horas: (h) => h < 1 ? `${Math.round(h * 60)} min` : `${h} h`,
    hace: (h) => h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} días`,
    hora: (iso) => iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '',
    fechaHora: (iso) => new Date(iso).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    nombreYo() { return this.negocio?.usuarios.find((u) => u.id === this.yo)?.nombre || '' },
    urlPedidos: () => location.origin + '/pedir.html',

    toast(texto, tipo = 'info', op = null) {
      const t = { id: Math.random(), texto, tipo, op }
      this.toasts.push(t)
      setTimeout(() => { this.toasts = this.toasts.filter((x) => x !== t) }, 7000)
    },

    irA(p) {
      this.pestana = p
      guardarLocal('pestana', p)
      if (p === 'tablero') this.$nextTick(() => dibujarGraficos(this.tablero))
      if (p === 'negocio') this.$nextTick(() => { dibujarQR(this.urlPedidos()); dibujarQR(location.origin + '/whatsapp.html', 'qrWa') })
      if (p === 'equipo') { this.avisosSinLeer = 0 }
    },

    // ---------- alta ----------
    elegirRubro(r) {
      this.alta.rubro = r.rubro
      if (!this.alta.nombre || RUBROS.some((x) => x.nombre === this.alta.nombre)) this.alta.nombre = r.nombre
    },
    async fotoLista(e) {
      const archivo = e.target.files[0]
      if (archivo) this.alta.imagen = await achicarImagen(archivo, 1600)
    },
    crearNegocio() {
      return this.intentar('ocupado', async () => {
        const { imagen, listaPrecios, ...resto } = this.alta
        const nuevo = await enviarJSON('POST', '/api/negocio', { ...resto, ...(imagen ? { imagen } : {}), ...(listaPrecios.trim() ? { listaPrecios } : {}) })
        this.negocio = nuevo
        this.yo = 1
        guardarLocal('yo', 1)
        this.pestana = 'bandeja'
        await this.alArrancar()
        this.toast(`${this.negocio.emoji} ¡Listo! Tu CRM de ${this.negocio.rubro.toLowerCase()} está armado.`, 'ok')
      })
    },
    // Cambiar de rubro desde Configuración: la IA rehace catálogo, bot, ícono y color; quedan equipo y WhatsApp.
    nuevoRubro: { rubro: '', nombre: '', ciudad: '', listaPrecios: '', borrarVentas: true },
    cambiarRubroIA() {
      const r = this.nuevoRubro
      if (r.borrarVentas && !confirm(`Se reemplazan el catálogo, el bot y las ventas de ejemplo por los de "${r.rubro}". El equipo y WhatsApp quedan. ¿Seguimos?`)) return
      return this.intentar('ocupado', async () => {
        this.negocio = await enviarJSON('POST', '/api/negocio/rubro', {
          rubro: r.rubro.trim(), nombre: r.nombre.trim() || this.negocio.nombre, ciudad: r.ciudad.trim() || this.negocio.ciudad,
          borrarVentas: r.borrarVentas, ...(r.listaPrecios.trim() ? { listaPrecios: r.listaPrecios } : {}),
        })
        this.config = JSON.parse(JSON.stringify(this.negocio))
        this.nuevoRubro = { rubro: '', nombre: '', ciudad: '', listaPrecios: '', borrarVentas: true }
        this.prioridades = null
        aplicarTema(this.negocio)
        await this.refrescar()
        this.toast(`${this.negocio.emoji} ¡Listo! Ahora sos ${this.negocio.nombre}. Tu asistente se llama ${this.negocio.botNombre}.`, 'ok')
      })
    },
    elegirRubroNuevo(r) {
      this.nuevoRubro.rubro = r.rubro
      this.nuevoRubro.nombre = r.nombre
    },
    cambiarRubro() {
      if (!confirm('Se borran el negocio y todas sus ventas. ¿Seguimos?')) return
      return this.intentar('guardando', async () => {
        await api('/api/negocio', { method: 'DELETE' })
        this.negocio = null
        this.tablero = null
        graficos = {}
        aplicarTema(null)
      })
    },

    // ---------- datos ----------
    async refrescar(silencioso = false) {
      const antes = new Set(this.ops.map((o) => o.id))
      const [ops, tablero] = await Promise.all([api('/api/oportunidades'), api('/api/tablero')])
      if (silencioso) {
        const previas = new Map(this.ops.map((o) => [o.id, o.etapa]))
        for (const o of ops) if (o.confirmadoPorCliente && previas.get(o.id) && previas.get(o.id) !== 'confirmado' && o.etapa === 'confirmado') {
          this.toast(`✅ ${o.cliente || 'Un cliente'} confirmó su pedido: ${this.pesos(o.total)}. ¡A preparar!`, 'ok', o.id)
          sonar()
        }
        for (const o of ops) if (antes.size && !antes.has(o.id) && ['web', 'whatsapp'].includes(o.canal) && Date.now() - new Date(o.creado) < 5 * 60_000) {
          this.toast(`${o.canal === 'web' ? '🌐 Nuevo pedido por el QR' : '🟢 Nuevo WhatsApp'}: ${o.cliente || 'cliente'} · ${o.resumen}`, 'ok', o.id)
          sonar()
        }
      }
      this.ops = ops
      this.tablero = tablero
      if (this.sel) this.sel = ops.find((o) => o.id === this.sel.id) || null
      if (this.pestana === 'tablero') dibujarGraficos(tablero)
    },

    columna(etapa) {
      const q = this.buscar.trim().toLowerCase()
      return this.ops.filter((o) => o.etapa === etapa && o.tipo !== 'no_es_venta'
        && (!this.soloMias || o.asignado === this.yo)
        && (!this.soloRiesgo || o.enRiesgo)
        && (!q || JSON.stringify([o.cliente, o.resumen, o.items.map((i) => i.producto)]).toLowerCase().includes(q)))
    },
    sumar: (lista) => lista.reduce((s, o) => s + (o.total || 0), 0),

    // ---------- bandeja ----------
    usarEjemplo() {
      const ej = this.negocio.ejemplos
      this.texto = ej[this.ejemplo++ % ej.length]
      return this.leer()
    },
    leer() {
      return this.intentar('ocupado', async () => {
        this.ficha = await enviarJSON('POST', '/api/leer', { texto: this.texto.trim() })
        this.ficha.mensajeOriginal = this.texto.trim()
      })
    },
    subirFoto(e, origen = 'foto') {
      const archivo = e.target.files[0]
      e.target.value = ''
      if (archivo) return this.leerImagen(archivo, origen)
    },
    // Foto de una lista, o captura de un chat de Instagram/WhatsApp: la IA la lee y arma la ficha.
    leerImagen(archivo, origen) {
      if (origen === 'captura_instagram') this.canal = 'instagram'
      if (origen === 'captura_whatsapp') this.canal = 'whatsapp'
      return this.intentar('ocupado', async () => {
        // Las capturas de chat tienen letra chica: se mandan más grandes.
        const imagen = await achicarImagen(archivo, origen === 'foto' ? 1280 : 1800)
        this.ficha = await enviarJSON('POST', '/api/leer', { imagen, origen })
        this.ficha.mensajeOriginal = { foto: '📷 [foto de la lista]', captura_instagram: '📸 [captura de Instagram] ', captura_whatsapp: '🟢 [captura de WhatsApp] ' }[origen]
          + (origen === 'foto' ? '' : this.ficha.analisis)
        this.toast(origen === 'captura_instagram' ? '📸 Captura de Instagram leída: revisá la ficha y mandala al embudo.' : '📷 Imagen leída.', 'ok')
      })
    },
    // Ctrl+V de una imagen en el cuadro de texto: se lee como captura del canal elegido.
    pegar(e) {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      return this.leerImagen(item.getAsFile(), this.canal === 'instagram' ? 'captura_instagram' : this.canal === 'whatsapp' ? 'captura_whatsapp' : 'foto')
    },
    async transcribirYLeer(cuerpo, ext) {
      const { texto } = await api('/api/audio', { method: 'POST', headers: { 'x-extension': ext }, body: cuerpo })
      this.texto = texto
      this.ficha = await enviarJSON('POST', '/api/leer', { texto })
      this.ficha.mensajeOriginal = '🎤 ' + texto
    },
    subirAudio(e) {
      const archivo = e.target.files[0]
      e.target.value = ''
      if (!archivo) return
      return this.intentar('ocupado', () => this.transcribirYLeer(archivo, archivo.name.split('.').pop()))
    },
    async grabar() {
      if (this.grabando) { this._grabador.stop(); return }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const partes = []
        this._grabador = new MediaRecorder(stream)
        this._grabador.ondataavailable = (ev) => partes.push(ev.data)
        this._grabador.onstop = () => {
          stream.getTracks().forEach((t) => t.stop())
          this.grabando = false
          const tipo = this._grabador.mimeType || 'audio/webm'
          this.intentar('ocupado', () => this.transcribirYLeer(new Blob(partes, { type: tipo }), tipo.includes('mp4') ? 'mp4' : tipo.includes('ogg') ? 'ogg' : 'webm'))
        }
        this._grabador.start()
        this.grabando = true
        this.ocupado = true
      } catch {
        this.error = 'No pude usar el micrófono. Revisá el permiso del navegador (hace falta HTTPS).'
      }
    },
    recalcular() {
      this.ficha.total = this.ficha.items.reduce((s, it) => s + (it.precio == null ? 0 : it.precio * it.cantidad), 0)
    },
    // El empleado anota en dos palabras y el bot sigue: arma la venta y le escribe al cliente para confirmar.
    pasarAlBot() {
      return this.intentar('guardando', async () => {
        const op = await enviarJSON('POST', '/api/bot/tomar', { texto: this.texto.trim(), canal: this.canal === 'whatsapp' ? 'telefono' : this.canal, quien: this.nombreYo() })
        this.texto = ''
        this.ficha = null
        await this.refrescar()
        this.toast(`🤖 El bot le escribió a ${op.cliente || 'el cliente'} por WhatsApp. Queda "a confirmar" hasta que diga que sí.`, 'ok')
        this.abrir(op)
      })
    },
    guardarFicha() {
      return this.intentar('guardando', async () => {
        const { total, sinPrecio, ...ficha } = this.ficha
        const op = await enviarJSON('POST', '/api/oportunidades', { ...ficha, canal: this.canal })
        this.ficha = null
        this.texto = ''
        await this.refrescar()
        this.toast(`Guardada y asignada a ${op.responsable}. Te aviso si se enfría.`, 'ok')
        this.abrir(op)
      })
    },

    // ---------- detalle ----------
    abrir(o) { this.sel = o; this.borrador = null; this.nota = '' },
    async abrirId(id) {
      if (!this.ops.some((o) => o.id === id)) await this.refrescar()
      const o = this.ops.find((x) => x.id === id)
      if (o) this.abrir(o)
    },
    async cambiar(o, cambio) {
      const nueva = await enviarJSON('PATCH', `/api/oportunidades/${o.id}`, { ...cambio, quien: this.nombreYo() })
      await this.refrescar()
      if (this.sel?.id === o.id) this.sel = nueva
      return nueva
    },
    moverA(o, etapa) {
      if (o.etapa === etapa) return
      let motivo
      if (etapa === 'perdido') {
        motivo = prompt('¿Por qué se perdió?\n' + MOTIVOS.map((m, i) => `${i + 1}. ${m}`).join('\n'), '1')
        if (motivo == null) return
        motivo = MOTIVOS[Number(motivo) - 1] || motivo
      }
      return this.intentar('guardando', async () => {
        await this.cambiar(o, { etapa, ...(motivo ? { motivoPerdida: motivo } : {}) })
        if (etapa === 'confirmado') this.toast(`✅ ¡Venta ganada! ${this.pesos(o.total)}`, 'ok')
      })
    },
    soltar(etapa) {
      const o = this.ops.find((x) => x.id === this.arrastrando)
      this.arrastrando = null
      if (o) return this.moverA(o, etapa)
    },
    asignar(o, id) { return this.intentar('guardando', () => this.cambiar(o, { asignado: id })) },
    posponer(o, min) {
      return this.intentar('guardando', async () => {
        await this.cambiar(o, { posponerMin: min })
        this.toast(`⏰ Te recuerdo esta venta en ${this.minutos(min)}.`)
      })
    },
    agregarNota(o) {
      const nota = this.nota.trim()
      return this.intentar('guardando', async () => { await this.cambiar(o, { nota }); this.nota = '' })
    },
    redactar(o, modo) {
      return this.intentar('redactando', async () => {
        this.borrador = await api(`/api/oportunidades/${o.id}/redactar?modo=${modo}`, { method: 'POST' })
      })
    },
    enviado(o) {
      const mensaje = this.borrador?.mensaje
      if (!mensaje) return
      this.intentar('guardando', async () => {
        await this.cambiar(o, { mensajeEnviado: mensaje })
        this.borrador = null
        this.toast('💬 Anotado como respondido. El reloj de avisos arranca de nuevo.', 'ok')
      })
    },
    enviarWa(o) {
      const mensaje = this.borrador?.mensaje?.trim()
      if (!mensaje) return
      return this.intentar('guardando', async () => {
        const r = await enviarJSON('POST', `/api/oportunidades/${o.id}/enviar`, { mensaje })
        await this.cambiar(o, { mensajeEnviado: mensaje })
        this.borrador = null
        this.toast(r.modo === 'real' ? '💬 Enviado por WhatsApp.' : '💬 Enviado (MOCK): miralo en el simulador.', 'ok')
      })
    },
    async copiar(texto) {
      try { await navigator.clipboard.writeText(texto); this.toast('Copiado 👍') } catch { prompt('Copialo de acá:', texto) }
    },

    // ---------- tablero ----------
    pedirPrioridades() {
      return this.intentar('pensando', async () => { this.prioridades = await api('/api/prioridades', { method: 'POST' }) })
    },

    // ---------- equipo y avisos ----------
    cambiarUsuario() {
      guardarLocal('yo', this.yo)
      this.avisos = []
      this.ultimoAviso = 0
      this.revisarAvisos(true)
    },
    async revisarAvisos(sinRuido = false) {
      const nuevos = await api(`/api/avisos?usuario=${this.yo}&desde=${this.ultimoAviso}`)
      if (!nuevos.length) return
      const vistos = this.ultimoAviso
      this.ultimoAviso = Math.max(...nuevos.map((a) => a.id), this.ultimoAviso)
      guardarLocal('ultimoAviso:' + this.yo, this.ultimoAviso)
      this.avisos = [...nuevos, ...this.avisos].slice(0, 40)
      if (sinRuido || !vistos) return   // al arrancar: se listan, no suenan todos juntos
      if (this.pestana !== 'equipo') this.avisosSinLeer += nuevos.length
      sonar()
      for (const a of nuevos.slice(0, 3)) {
        this.toast('⏰ ' + a.texto, 'alerta', a.oportunidad)
        if (this.permisoNotif === 'granted') {
          const n = new Notification(`⏰ ${this.negocio.nombre}: no pierdas esta venta`, { body: a.texto, tag: 'op-' + a.oportunidad })
          n.onclick = () => { window.focus(); this.abrirId(a.oportunidad) }
        }
      }
      this.refrescar().catch(() => {})
    },
    async activarNotificaciones() {
      if (typeof Notification === 'undefined') { this.error = 'Este navegador no tiene notificaciones.'; return }
      this.permisoNotif = await Notification.requestPermission()
      if (this.permisoNotif === 'granted') {
        sonar()
        new Notification('🔔 Mostrador', { body: `Listo, ${this.nombreYo()}: te aviso cuando una venta se enfríe.` })
      } else this.error = 'Sin permiso no puedo mandarte notificaciones (hace falta HTTPS y aceptar el permiso).'
    },
    agregarUsuario() {
      const id = Math.max(...this.config.usuarios.map((u) => u.id)) + 1
      this.config.usuarios.push({ id, nombre: 'Nueva persona', rol: 'vendedor', telefono: null })
    },
    guardarConfig() {
      return this.intentar('guardando', async () => {
        const { nombre, saludo, enfriaHoras, recordatorioMin, escalarTras, usuarios, catalogo, whatsapp,
          emoji, color, botNombre, botPersonalidad, palabraVenta, palabraCliente } = this.config
        this.negocio = await enviarJSON('PUT', '/api/negocio', {
          nombre, saludo, enfriaHoras, recordatorioMin, escalarTras,
          emoji: emoji || '🏪', color: color || '#0b6e4f', botNombre: botNombre || '', botPersonalidad: botPersonalidad || '',
          palabraVenta: palabraVenta || 'pedido', palabraCliente: palabraCliente || 'cliente',
          whatsapp: { ...whatsapp, token: whatsapp.token || null, appSecret: whatsapp.appSecret || null, phoneNumberId: whatsapp.phoneNumberId || null, verifyToken: whatsapp.verifyToken || '' },
          usuarios: usuarios.map((u) => ({ ...u, telefono: u.telefono?.trim() || null })),
          catalogo: catalogo.filter((p) => p.producto.trim()).map((p) => ({ ...p, precio: p.precio === '' || p.precio == null ? null : Number(p.precio) })),
        })
        this.config = JSON.parse(JSON.stringify(this.negocio))
        aplicarTema(this.negocio)
        await this.refrescar()
        this.toast('Guardado 👍', 'ok')
      })
    },
  }))
})
