import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { type } from 'arktype'
import OpenAI, { toFile } from 'openai'
import { standardResponseFormat } from 'openai/helpers/standard-schema'
import Database from 'better-sqlite3'

// Con Node 20, better-sqlite3 13 se cae con "Segmentation fault", sin otro aviso.
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Hace falta Node 22 (tenés ${process.version}).`)
// pm2 arranca la app en la carpeta desde donde lo llamás: sin esto no encuentra el .env.
process.chdir(import.meta.dirname)
try { process.loadEnvFile() } catch {}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
const MODEL_AUDIO = process.env.OPENAI_AUDIO_MODEL || 'whisper-1'
const openai = new OpenAI({ maxRetries: 2, timeout: 60_000 })

// ---------------------------------------------------------------------------
// Base de datos: el JSON entero en `datos`, y aparte lo que se usa para filtrar.
// ---------------------------------------------------------------------------
const db = new Database(process.env.DB_FILE || 'data.db')
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS negocio (id INTEGER PRIMARY KEY CHECK (id = 1), datos TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS oportunidades (
    id INTEGER PRIMARY KEY, creado TEXT NOT NULL, actualizado TEXT NOT NULL, etapa TEXT NOT NULL, datos TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cache (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wa_mensajes (
    id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, telefono TEXT NOT NULL, de TEXT NOT NULL, texto TEXT NOT NULL, waid TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS avisos (
    id INTEGER PRIMARY KEY, creado TEXT NOT NULL, usuario INTEGER NOT NULL, oportunidad INTEGER NOT NULL, texto TEXT NOT NULL
  );
`)

const leerCache = db.prepare('SELECT valor FROM cache WHERE clave = ?')
const escribirCache = db.prepare('INSERT OR REPLACE INTO cache (clave, valor) VALUES (?, ?)')
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex')

// Devuelve lo guardado para `clave`, o corre `fn` y lo guarda. Si `fn` falla, no guarda nada.
async function conCache(clave, fn) {
  const fila = leerCache.get(clave)
  if (fila) return JSON.parse(fila.valor)
  const valor = await fn()
  escribirCache.run(clave, JSON.stringify(valor))
  return valor
}

const ahora = () => new Date().toISOString()
const horasDesde = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const limitar = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0))

// ArkType escribe los textos fijos como {enum} o {const} sin "type", y el modo estricto de OpenAI exige "type".
// Se lo agregamos a todo el schema antes de mandarlo (la validación de la respuesta sigue siendo la de ArkType).
function conTipos(nodo) {
  if (Array.isArray(nodo)) return nodo.forEach(conTipos)
  if (!nodo || typeof nodo !== 'object') return
  if (!nodo.type && (nodo.enum || nodo.const !== undefined)) {
    const valores = nodo.enum ?? [nodo.const]
    if (valores.every((v) => typeof v === 'string')) nodo.type = 'string'
  }
  Object.values(nodo).forEach(conTipos)
}
function formato(tipo, nombre) {
  const f = standardResponseFormat(tipo, nombre)
  conTipos(f.json_schema.schema)
  return f
}

function leerNegocio() {
  const fila = db.prepare('SELECT datos FROM negocio WHERE id = 1').get()
  return fila ? JSON.parse(fila.datos) : null
}
function guardarNegocio(negocio) {
  db.prepare('INSERT OR REPLACE INTO negocio (id, datos) VALUES (1, ?)').run(JSON.stringify(negocio))
}

// La IA que contesta siempre (salida estructurada + validada con el mismo tipo de ArkType).
// La URL va en la clave del caché: al cambiar de key o de modelo no vuelven respuestas viejas.
async function pedirJSON(formato, messages) {
  return conCache('ia:' + hash([openai.baseURL, MODEL, formato.json_schema, messages]), async () => {
    const r = await openai.chat.completions.parse({ model: MODEL, messages, response_format: formato })
    const mensaje = r.choices[0].message
    if (!mensaje.parsed) throw new Error(mensaje.refusal || 'La IA no devolvió datos.')
    return mensaje.parsed
  })
}

// ---------------------------------------------------------------------------
// 1. Alta del negocio: la IA adapta el CRM al rubro.
// ---------------------------------------------------------------------------
const Rubro = type({
  analisis: 'string',
  botNombre: 'string',
  botPersonalidad: 'string',
  catalogo: type({ precio: 'number | null', precioSugerido: 'number', producto: 'string', unidad: 'string' }).array(),
  color: 'string',
  datosParaCerrar: 'string[]',
  ejemplos: 'string[]',
  emoji: 'string',
  emojisAlternativos: 'string[]',
  enfriaHoras: 'number',
  palabraCliente: 'string',
  palabraVenta: 'string',
  saludo: 'string',
})
const formatoRubro = formato(Rubro, 'rubro')

const PROMPT_RUBRO = `Sos consultor de ventas de comercios de barrio en Argentina. Te paso el nombre, el rubro y la ciudad de un negocio que hoy atiende por WhatsApp y teléfono, y a veces su lista de precios (texto o foto). Prepará su CRM y la personalidad de su asistente virtual.

- analisis: dos frases: cómo compran los clientes de este rubro y dónde se le escapan las ventas.
- botNombre: un nombre corto, simpático y del rubro para el asistente que atiende el WhatsApp (ej. ferretería: "Tuerca"; rotisería: "Rosita"; veterinaria: "Firulais"; taller: "Pistón"). Sin la palabra "bot".
- botPersonalidad: 2 o 3 frases que describen cómo habla el asistente: tono, la jerga y las palabras típicas de ESTE rubro que usa con naturalidad (ej. ferretería: habla de medidas, "te lo separo", "pasá a retirar por el mostrador"; veterinaria: pregunta por la mascota por su nombre, habla de "turno" y "consulta"). Rioplatense.
- catalogo: si te pasan una lista de precios, copiá SOLO esos productos con su precio tal cual (números, sin $ ni puntos de miles). Si no te pasan lista, proponé entre 12 y 16 productos o servicios típicos del rubro con precio null. unidad: "u", "kg", "m", "hora", "caja", "turno", etc.
- precioSugerido: para cada producto, un precio de referencia aproximado en pesos argentinos de hoy (número entero), para arrancar la demo; el dueño lo revisa. Si te pasaron la lista, repetí el precio de la lista.
- color: un color hexadecimal (#rrggbb) que represente al rubro y se lea bien con texto blanco encima (oscuro o medio, nunca pastel).
- datosParaCerrar: de 3 a 5 datos que el negocio necesita para cerrar una venta en este rubro (ej. ferretería: medidas, cantidad, retiro o envío; veterinaria: especie y peso del animal).
- ejemplos: 3 mensajes de WhatsApp realistas de clientes de este rubro, en rioplatense, como los escribe la gente (sin tildes, abreviado). El primero un pedido claro con nombre y dirección, el segundo ambiguo (falta cantidad o medida), el tercero una consulta de precio y disponibilidad.
- emoji: un solo emoji que represente al rubro. emojisAlternativos: 4 emojis más que también lo representen.
- enfriaHoras: cuántas horas puede esperar un cliente de este rubro sin respuesta antes de comprarle a otro (comida: 0.5 a 1; almacén: 2; ferretería o corralón: 6 a 24; servicios grandes: 24 a 48).
- palabraVenta: cómo le dice este rubro a una venta, en singular y minúscula ("pedido", "turno", "presupuesto", "encargo", "reserva"). palabraCliente: cómo le dice al cliente ("cliente", "paciente", "comensal", "vecino").
- saludo: la primera frase que ve el cliente en la página de pedidos, cálida y corta, con el nombre del negocio y del asistente.
- El catálogo NUNCA va vacío para un negocio real: sin lista de precios, proponé igual los 12 a 16 productos o servicios típicos con precio null.
- Solo si el rubro no es un negocio (un insulto, algo sin sentido), explicalo en analisis y dejá catalogo vacío.`

const DatosRubro = type({
  nombre: '0 < string <= 80',
  rubro: '0 < string <= 120',
  ciudad: 'string <= 80',
  'listaPrecios?': 'string <= 6000',
  'imagen?': /^data:image\//,
  'conEjemplos?': 'boolean',
})
const AltaNegocio = DatosRubro.and({ 'admin?': 'string <= 60', 'equipo?': 'string <= 300' })

const emojiValido = (e, def) => {
  const x = [...String(e || '')].slice(0, 2).join('').trim()
  return x && /\p{Extended_Pictographic}/u.test(x) ? x : def
}
// El color del rubro tiene que leerse con texto blanco encima: si es claro, se oscurece.
function colorValido(c) {
  const hex = String(c || '').trim()
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#0b6e4f'
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const luz = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (luz > 0.45) { const k = 0.45 / luz; [r, g, b] = [r, g, b].map((v) => Math.round(v * k)) }
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

// La IA arma todo lo que depende del rubro: catálogo, personalidad del bot, ícono, color, vocabulario.
async function armarRubro(body) {
  const pedido = `Negocio: ${body.nombre}\nRubro: ${body.rubro}\nCiudad: ${body.ciudad || 'Rosario'}` +
    (body.listaPrecios?.trim() ? `\n\nLista de precios:\n${body.listaPrecios.trim()}` : '\n\nNo pasó lista de precios.')
  const contenido = body.imagen
    ? [{ type: 'text', text: pedido + '\n\nTe paso la foto de su lista de precios.' }, { type: 'image_url', image_url: { url: body.imagen } }]
    : pedido
  let r = await pedirJSON(formatoRubro, [{ role: 'system', content: PROMPT_RUBRO }, { role: 'user', content: contenido }])
  // Si vino sin catálogo, un segundo intento más explícito (el modelo chico a veces se confunde sin lista de precios).
  if (!r.catalogo.length) r = await pedirJSON(formatoRubro, [{ role: 'system', content: PROMPT_RUBRO },
    { role: 'user', content: contenido }, { role: 'assistant', content: JSON.stringify(r) },
    { role: 'user', content: 'El catálogo vino vacío. Es un negocio real: proponé de 12 a 16 productos o servicios típicos de este rubro con precio null.' }])
  if (!r.catalogo.length) return { error: `La IA no pudo armar el negocio: ${r.analisis}` }
  const emoji = emojiValido(r.emoji, '🏪')
  return {
    nombre: body.nombre.trim(),
    rubro: body.rubro.trim(),
    ciudad: body.ciudad?.trim() || 'Rosario',
    analisis: r.analisis,
    // Sin lista de precios: se usa el precio sugerido por la IA, marcado como "sugerido" para que el dueño lo revise.
    catalogo: r.catalogo.slice(0, 40).map(({ precioSugerido, ...p }) => p.precio != null
      ? { ...p, precio: Math.max(0, p.precio) }
      : { ...p, precio: precioSugerido > 0 ? Math.round(precioSugerido) : null, sugerido: precioSugerido > 0 }),
    datosParaCerrar: r.datosParaCerrar.slice(0, 6),
    ejemplos: r.ejemplos.slice(0, 3),
    emoji,
    emojis: [...new Set([emoji, ...r.emojisAlternativos.map((e) => emojiValido(e, null)).filter(Boolean)])].slice(0, 6),
    color: colorValido(r.color),
    botNombre: r.botNombre.trim().slice(0, 30) || 'Asistente',
    botPersonalidad: r.botPersonalidad.trim().slice(0, 600),
    palabraVenta: (r.palabraVenta || 'pedido').trim().toLowerCase().slice(0, 20),
    palabraCliente: (r.palabraCliente || 'cliente').trim().toLowerCase().slice(0, 20),
    enfriaHoras: limitar(r.enfriaHoras, 0.25, 72),
    saludo: r.saludo,
  }
}

const app = new Hono()
app.use(logger())

app.get('/api/health', (c) => c.json({ ok: true, modelo: MODEL, negocio: leerNegocio()?.nombre ?? null }))

// Los secretos de WhatsApp nunca vuelven a la página: solo si están cargados.
const enmascarar = (s) => (s ? '••••' + String(s).slice(-4) : null)
function negocioPublico(n) {
  if (!n) return null
  const wa = n.whatsapp || {}
  return { ...n, whatsapp: { ...wa, token: enmascarar(wa.token), appSecret: enmascarar(wa.appSecret) } }
}
app.get('/api/negocio', (c) => c.json(negocioPublico(leerNegocio())))

app.post('/api/negocio', async (c) => {
  const body = AltaNegocio(await c.req.json())
  if (body instanceof type.errors) return c.json({ error: 'Completá el nombre y el rubro del negocio.' }, 400)
  const rubro = await armarRubro(body)
  if (rubro.error) return c.json({ error: rubro.error }, 422)
  const negocio = {
    ...rubro,
    // Equipo y avisos: cada venta tiene un responsable y se le avisa cada `recordatorioMin` hasta que la atienda.
    usuarios: [
      { id: 1, nombre: body.admin?.trim() || 'Dueño', rol: 'admin', telefono: null },
      ...(body.equipo || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10)
        .map((nombre, i) => ({ id: i + 2, nombre: nombre.slice(0, 60), rol: 'vendedor', telefono: null })),
    ],
    recordatorioMin: 15,
    escalarTras: 2,
    whatsapp: { modo: 'mock', autoResponder: true, token: null, phoneNumberId: null, verifyToken: 'mostrador-' + Math.random().toString(36).slice(2, 8), appSecret: null },
    creado: ahora(),
  }
  db.prepare('DELETE FROM oportunidades').run()
  db.prepare('DELETE FROM avisos').run()
  guardarNegocio(negocio)
  if (body.conEjemplos !== false) cargarEjemplos(negocio)
  return c.json(negocioPublico(negocio), 201)
})

// Cambiar de rubro desde Configuración: se rehace lo del rubro y quedan el equipo, WhatsApp y las reglas de avisos.
app.post('/api/negocio/rubro', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  const body = DatosRubro.and({ 'borrarVentas?': 'boolean' })(await c.req.json())
  if (body instanceof type.errors) return c.json({ error: 'Completá el nombre y el rubro.' }, 400)
  const rubro = await armarRubro(body)
  if (rubro.error) return c.json({ error: rubro.error }, 422)
  const nuevo = { ...negocio, ...rubro, rubroAnterior: negocio.rubro, rubroCambiado: ahora() }
  if (body.borrarVentas !== false) {
    db.prepare('DELETE FROM oportunidades').run()
    db.prepare('DELETE FROM avisos').run()
    db.prepare('DELETE FROM wa_mensajes').run()
  }
  guardarNegocio(nuevo)
  // Datos de demo del rubro nuevo: solo si lo pidió (se pregunta al cambiar de rubro).
  if (body.conEjemplos === true) cargarEjemplos(nuevo)
  return c.json(negocioPublico(nuevo))
})

const EdicionNegocio = type({
  nombre: '0 < string <= 80',
  saludo: 'string <= 300',
  enfriaHoras: '0 < number <= 72',
  recordatorioMin: '1 <= number <= 1440',
  escalarTras: '1 <= number <= 10',
  'emoji?': 'string <= 16', 'color?': 'string <= 9', 'botNombre?': 'string <= 30', 'botPersonalidad?': 'string <= 600',
  'palabraVenta?': 'string <= 20', 'palabraCliente?': 'string <= 20',
  'mostrarAyuda?': 'boolean',
  'whatsapp?': {
    modo: "'mock' | 'real'", autoResponder: 'boolean',
    token: 'string | null', phoneNumberId: 'string | null', verifyToken: 'string <= 100', appSecret: 'string | null',
  },
  usuarios: type({ id: 'number', nombre: '0 < string <= 60', rol: "'admin' | 'vendedor'", telefono: 'string | null' }).array().atLeastLength(1).atMostLength(20),
  catalogo: type({ producto: '0 < string <= 120', unidad: 'string <= 20', precio: 'number | null', 'sugerido?': 'boolean' }).array().atMostLength(80),
})

app.put('/api/negocio', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  const body = EdicionNegocio(await c.req.json())
  if (body instanceof type.errors) return c.json({ error: body.summary }, 400)
  if (!body.usuarios.some((u) => u.rol === 'admin')) return c.json({ error: 'Tiene que quedar al menos un administrador.' }, 400)
  if (body.whatsapp) {
    const viejo = negocio.whatsapp || {}
    // Si llega enmascarado o vacío, queda el que estaba.
    const secreto = (nuevo, antes) => (!nuevo || nuevo.startsWith('••••') ? antes : nuevo.trim())
    body.whatsapp = { ...body.whatsapp, token: secreto(body.whatsapp.token, viejo.token), appSecret: secreto(body.whatsapp.appSecret, viejo.appSecret),
      phoneNumberId: body.whatsapp.phoneNumberId?.trim() || null }
    if (body.whatsapp.modo === 'real' && !(body.whatsapp.token || process.env.WHATSAPP_TOKEN) ) return c.json({ error: 'Para la API real de WhatsApp falta el token de acceso.' }, 400)
    if (body.whatsapp.modo === 'real' && !body.whatsapp.phoneNumberId) return c.json({ error: 'Para la API real de WhatsApp falta el Phone Number ID.' }, 400)
  }
  if ('emoji' in body) body.emoji = emojiValido(body.emoji, negocio.emoji)
  if ('color' in body) body.color = colorValido(body.color)
  if ('botNombre' in body) body.botNombre = body.botNombre.trim() || negocio.botNombre
  Object.assign(negocio, body)
  guardarNegocio(negocio)
  return c.json(negocioPublico(negocio))
})

app.delete('/api/negocio', (c) => {
  db.prepare('DELETE FROM avisos').run()
  db.prepare('DELETE FROM wa_mensajes').run()
  db.prepare('DELETE FROM oportunidades').run()
  db.prepare('DELETE FROM negocio').run()
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// 2. Leer un mensaje (WhatsApp, nota de una llamada, foto, audio) y armar la oportunidad.
// ---------------------------------------------------------------------------
const camposLectura = {
  analisis: 'string',
  cliente: 'string | null',
  direccion: 'string | null',
  entrega: "'envio' | 'retiro' | null",
  faltaInfo: 'string[]',
  items: type({ cantidad: 'number', enCatalogo: 'boolean', nota: 'string | null', producto: 'string' }).array(),
  probabilidad: 'number',
  proximaAccion: 'string',
  resumen: 'string',
  telefono: 'string | null',
  tipo: "'pedido' | 'presupuesto' | 'consulta' | 'reclamo' | 'no_es_venta'",
  urgencia: "'alta' | 'media' | 'baja'",
}
const Lectura = type(camposLectura)
const formatoLectura = formato(Lectura, 'lectura')
// La misma lectura, más la respuesta para el cliente (la página pública de pedidos).
const Charla = type({ ...camposLectura, clienteConfirmo: 'boolean', respuesta: 'string' })
const formatoCharla = formato(Charla, 'charla')

const textoCatalogo = (n) => n.catalogo.map((p) => `- ${p.producto} (${p.unidad})${p.precio != null ? ` $${p.precio}` : ''}`).join('\n')

const reglasLectura = (n) => `Negocio: ${n.nombre}, rubro ${n.rubro}, en ${n.ciudad}.
Catálogo (los únicos productos con precio):
${textoCatalogo(n)}

Datos que este negocio necesita para cerrar una venta: ${n.datosParaCerrar.join('; ')}.

Reglas, una por campo:
- analisis: una o dos frases: qué quiere el cliente, qué quedó ambiguo y qué tan cerca está de comprar.
- tipo: pedido (quiere comprar ya), presupuesto (pide precio de varias cosas o un trabajo), consulta (pregunta precio, stock u horario de algo puntual), reclamo, no_es_venta (spam, saludo suelto, algo que no tiene que ver con el negocio).
- items: uno por producto que nombra. producto: si está en el catálogo (aunque lo nombre distinto, en plural, abreviado o con una variante como sabor, medida o color), escribí el nombre EXACTO del catálogo, enCatalogo true y la variante en nota; si no está, escribilo como lo dijo el cliente y enCatalogo false. cantidad siempre numérica: "media docena" es 6, "un cuarto" es 0.25; si no dice, 1 y agregá la pregunta en faltaInfo. nota: medida, marca, color o detalle que dio, o null. Nunca pongas precios: los calcula el sistema con el catálogo.
- cliente: el nombre de quien pide o de la persona para quien es el pedido ("soy Marta", "para María Claudia", "a nombre de Juan" → ese nombre). Solo null si no aparece ningún nombre de persona. telefono: solo si aparece escrito en el mensaje, con los dígitos; si no, null.
- direccion: calle y altura como la escribió, sin agregar ciudad ("de Callao 123", "a Callao 123", "en Callao 123" → "Callao 123"); null si no la dio.
- entrega: retiro si dice que pasa a buscar o retira; envio si pide que se lo manden o si da una dirección para el pedido; null solo si no hay ninguna pista.
- faltaInfo: no preguntes lo que el mensaje ya dice (nombre, dirección, cantidad). Las preguntas concretas (en segunda persona, rioplatense) que hay que hacerle para cerrar la venta, usando los datos que este negocio necesita. Vacío si no falta nada.
- probabilidad: de 0 a 100, qué tan probable es que compre si le respondemos bien y rápido.
- urgencia: alta si lo necesita hoy o en horas, o si es un reclamo; media si es para estos días; baja si solo averigua.
- proximaAccion: la acción concreta que tiene que hacer el negocio ahora, en una frase con verbo (ej. "Mandarle el total y preguntar si retira o le enviamos").
- resumen: máximo 8 palabras para la tarjeta del embudo (ej. "3 bolsas de cemento + arena, envío").
- No inventes datos: si algo no está en el mensaje, null y la pregunta en faltaInfo.
- Si el mensaje no tiene que ver con el negocio, tipo no_es_venta, items vacío, probabilidad 0 y explicalo en analisis.`

const PROMPT_LECTURA = (n) => `Sos el asistente de ventas de un comercio. Te llega un mensaje de un cliente (copiado de WhatsApp, la nota de una llamada, la transcripción de un audio o la foto de una lista). Armá la ficha de la venta.

${reglasLectura(n)}`

// Cómo habla el bot de este rubro (nombre, jerga, vocabulario).
const voz = (n) => `Te llamás ${n.botNombre || 'el asistente'} y atendés el WhatsApp de ${n.nombre} (${n.rubro}, ${n.ciudad}).
Cómo hablás: ${n.botPersonalidad || 'cálido, claro y corto, en rioplatense'}
Vocabulario del rubro: a una venta le decís "${n.palabraVenta || 'pedido'}" y al cliente "${n.palabraCliente || 'cliente'}". Usá las palabras típicas del rubro con naturalidad, sin exagerar.`

const PROMPT_CHARLA = (n) => `${voz(n)}
Te paso la conversación con un ${n.palabraCliente || 'cliente'}. Leé TODA la conversación, armá la ficha de la venta con lo último que se sabe y escribí la próxima respuesta.

${reglasLectura(n)}
- clienteConfirmo: true SOLO si en su último mensaje el cliente acepta explícitamente el pedido ya detallado (ej. "sí", "dale", "confirmo", "mandalo") y ya se sabe qué lleva y si retira o se envía. Si pregunta, duda, cambia algo o solo saluda: false.
- respuesta: lo que le contestás al cliente ahora. Los precios del catálogo son reales: decilos siempre (precio unitario y total con formato $12.345); solo si un producto no tiene precio decí que se lo confirman. Si falta algo para cerrar, pedilo; cuando ya sabés qué lleva y si retira o se envía, resumí el pedido con el total y pedile que responda "SÍ" para confirmarlo. Si clienteConfirmo es true, agradecé y decile que el pedido quedó confirmado y ya lo empiezan a preparar.
- Además, en la respuesta: rioplatense, cálido y corto (2 a 5 líneas). Confirmá lo que entendiste. Si hay productos con precio en el catálogo, decí el precio unitario tal cual figura; si no tiene precio o no está en el catálogo, decí que el negocio le confirma el precio enseguida. Hacé como mucho 2 preguntas de faltaInfo por vez. Nunca inventes precios, stock, horarios ni promociones, y no digas que el total incluye el envío: si preguntan, el costo de envío se lo confirma el negocio.`

// Le pone precio con el catálogo (no con la IA) y calcula el total.
function conPrecios(lectura, negocio) {
  const porNombre = new Map(negocio.catalogo.map((p) => [normalizar(p.producto), p]))
  const items = lectura.items.map((it) => {
    const nombre = normalizar(it.producto)
    const p = porNombre.get(nombre) ?? negocio.catalogo.find((x) => {
      const n = normalizar(x.producto)
      return n.length > 3 && (nombre.includes(n) || n.includes(nombre))
    })
    const precio = p?.precio ?? null
    return { ...it, producto: p?.producto ?? it.producto, enCatalogo: !!p, unidad: p?.unidad ?? null, precio, subtotal: precio == null ? null : Math.round(precio * it.cantidad) }
  })
  const total = items.reduce((s, it) => s + (it.subtotal || 0), 0)
  return { ...lectura, items, total, sinPrecio: items.filter((it) => it.precio == null).length, probabilidad: limitar(lectura.probabilidad, 0, 100) }
}

const Entrada = type({ 'texto?': '0 < string <= 4000', 'imagen?': /^data:image\//, 'origen?': "'foto' | 'captura_instagram' | 'captura_whatsapp'" })

// Qué le decimos a la IA según de dónde viene la imagen.
const INSTRUCCION_IMAGEN = {
  foto: 'Foto que mandó el cliente (una lista escrita a mano, un pedido o un producto):',
  captura_instagram: `Captura de pantalla de una conversación de Instagram (mensajes directos o comentarios) entre un cliente y el negocio.
- Los mensajes del CLIENTE suelen estar a la izquierda (burbujas grises); los del negocio, a la derecha (de color). Armá la ficha con lo que pide el cliente; lo que ya contestó el negocio sirve de contexto.
- cliente: el nombre o el @usuario que se ve arriba del chat o junto al comentario (con @ si es un usuario).
- telefono: solo si el cliente lo escribió en el chat; si no, null y pedilo en faltaInfo (hace falta para seguir por WhatsApp).
- En analisis, resumí en una frase lo que se habló en la captura.
- Si la captura no es una conversación con un cliente (una publicación suelta, una historia sin mensajes), explicalo en analisis.`,
  captura_whatsapp: `Captura de pantalla de una conversación de WhatsApp entre un cliente y el negocio.
- Los mensajes del CLIENTE están a la izquierda (burbujas blancas); los del negocio, a la derecha (verdes). Armá la ficha con lo que pide el cliente.
- cliente: el nombre que se ve arriba del chat. telefono: el número si se ve arriba o en el chat; si no, null.
- En analisis, resumí en una frase lo que se habló en la captura.`,
}

app.post('/api/leer', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  const body = Entrada(await c.req.json())
  if (body instanceof type.errors) return c.json({ error: 'El mensaje es muy largo o la imagen no es válida.' }, 400)
  if (!body.texto && !body.imagen) return c.json({ error: 'Pegá un mensaje, subí una foto o grabá un audio.' }, 400)
  const contenido = body.imagen
    ? [{ type: 'text', text: INSTRUCCION_IMAGEN[body.origen || 'foto'] }, { type: 'image_url', image_url: { url: body.imagen, detail: body.origen?.startsWith('captura') ? 'high' : 'auto' } }]
    : body.texto
  const lectura = await pedirJSON(formatoLectura, [
    { role: 'system', content: PROMPT_LECTURA(negocio) },
    { role: 'user', content: contenido },
  ])
  return c.json(conPrecios(lectura, negocio))
})

// ---------------------------------------------------------------------------
// 3. Audio (nota de voz de WhatsApp o grabado en el momento) → texto.
// ---------------------------------------------------------------------------
const FORMATOS_AUDIO = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']

app.post('/api/audio', async (c) => {
  const audio = Buffer.from(await c.req.arrayBuffer())
  if (!audio.length) return c.json({ error: 'El audio llegó vacío.' }, 400)
  if (audio.length > 24 * 1024 * 1024) return c.json({ error: 'El audio pesa más de 24 MB.' }, 400)
  const pedida = (c.req.header('x-extension') || 'webm').toLowerCase().replace(/[^a-z0-9]/g, '')
  const ext = pedida === 'opus' ? 'ogg' : pedida
  if (!FORMATOS_AUDIO.includes(ext)) return c.json({ error: `No se pueden transcribir archivos .${pedida}.` }, 400)
  const texto = await conCache('audio:' + hash([MODEL_AUDIO, createHash('sha256').update(audio).digest('hex')]), async () => {
    const t = await openai.audio.transcriptions.create({ file: await toFile(audio, `audio.${ext}`), model: MODEL_AUDIO, language: 'es' })
    return t.text
  })
  if (!texto.trim()) return c.json({ error: 'No se escuchó nada en el audio.' }, 422)
  return c.json({ texto })
})

// ---------------------------------------------------------------------------
// 4. Oportunidades: el embudo de ventas.
// ---------------------------------------------------------------------------
const ETAPAS = ['nuevo', 'respondido', 'confirmado', 'entregado', 'perdido']
const ABIERTAS = ['nuevo', 'respondido', 'confirmado']
const CANALES = ['whatsapp', 'telefono', 'web', 'mostrador', 'instagram']

function filaAOportunidad({ datos, ...fila }, negocio) {
  const op = { ...JSON.parse(datos), ...fila }
  const horas = horasDesde(op.ultimaActividad || op.actualizado)
  op.horasSinRespuesta = Math.round(horas * 10) / 10
  // En riesgo: nadie le contestó (o quedó esperando) más de lo que aguanta un cliente de este rubro.
  op.enRiesgo = ['nuevo', 'respondido'].includes(op.etapa) && op.tipo !== 'no_es_venta' && horas > (negocio?.enfriaHoras ?? 2)
  op.responsable = negocio?.usuarios?.find((u) => u.id === op.asignado)?.nombre ?? null
  op.avisoVencido = ABIERTAS.includes(op.etapa) && !!op.proximoAviso && op.proximoAviso <= ahora()
  return op
}

function listarOportunidades() {
  const negocio = leerNegocio()
  return db.prepare('SELECT * FROM oportunidades ORDER BY actualizado DESC').all().map((f) => filaAOportunidad(f, negocio))
}

function leerOportunidad(id) {
  const fila = db.prepare('SELECT * FROM oportunidades WHERE id = ?').get(id)
  return fila ? filaAOportunidad(fila, leerNegocio()) : null
}

// Saca los campos calculados antes de guardar.
function guardarOportunidad(op) {
  const { id, creado, actualizado, etapa, horasSinRespuesta, enRiesgo, responsable, avisoVencido, ...datos } = op
  const t = ahora()
  if (id) {
    db.prepare('UPDATE oportunidades SET actualizado = ?, etapa = ?, datos = ? WHERE id = ?').run(t, etapa, JSON.stringify(datos), id)
    return id
  }
  return Number(db.prepare('INSERT INTO oportunidades (creado, actualizado, etapa, datos) VALUES (?, ?, ?, ?)')
    .run(creado || t, actualizado || t, etapa || 'nuevo', JSON.stringify(datos)).lastInsertRowid)
}

// El responsable nuevo: el que tiene menos ventas abiertas (reparte el trabajo).
function elegirResponsable(negocio) {
  const abiertas = listarOportunidades().filter((o) => ABIERTAS.includes(o.etapa))
  const carga = (u) => abiertas.filter((o) => o.asignado === u.id).length
  return [...(negocio.usuarios || [])].sort((a, b) => carga(a) - carga(b) || a.id - b.id)[0]?.id ?? null
}
const enMinutos = (min) => new Date(Date.now() + min * 60_000).toISOString()
const evento = (op, texto, quien = null) => { op.eventos = [...(op.eventos || []), { fecha: ahora(), texto, quien }] }

// Una venta nueva: responsable, primer aviso y la primera línea del historial.
function nacer(op, negocio, origen) {
  op.etapa = 'nuevo'
  op.historial = [{ etapa: 'nuevo', fecha: ahora() }]
  op.asignado = elegirResponsable(negocio)
  op.proximoAviso = enMinutos(negocio.recordatorioMin ?? 15)
  op.avisosDados = 0
  evento(op, `Entró por ${origen}. Asignada a ${negocio.usuarios?.find((u) => u.id === op.asignado)?.nombre ?? 'nadie'}.`)
}

const ItemFicha = type({
  cantidad: 'number >= 0', enCatalogo: 'boolean', nota: 'string | null', producto: '0 < string <= 120',
  'unidad?': 'string | null', 'precio?': 'number | null', 'subtotal?': 'number | null',
})
const Ficha = type({
  analisis: 'string', cliente: 'string | null', direccion: 'string | null', entrega: "'envio' | 'retiro' | null",
  faltaInfo: 'string[]', items: ItemFicha.array(), probabilidad: 'number', proximaAccion: 'string', resumen: 'string',
  telefono: 'string | null', tipo: "'pedido' | 'presupuesto' | 'consulta' | 'reclamo' | 'no_es_venta'",
  urgencia: "'alta' | 'media' | 'baja'", canal: 'string', 'mensajeOriginal?': 'string <= 4000',
})

app.get('/api/oportunidades', (c) => c.json(listarOportunidades()))

app.post('/api/oportunidades', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  const ficha = Ficha(await c.req.json())
  if (ficha instanceof type.errors) return c.json({ error: ficha.summary }, 400)
  const { mensajeOriginal, ...resto } = ficha
  const op = conPrecios(resto, negocio)
  op.canal = CANALES.includes(ficha.canal) ? ficha.canal : 'whatsapp'
  op.ultimaActividad = ahora()
  nacer(op, negocio, op.canal)
  op.mensajes = mensajeOriginal ? [{ de: 'cliente', texto: mensajeOriginal, fecha: ahora() }] : []
  return c.json(leerOportunidad(guardarOportunidad(op)), 201)
})

const Cambio = type({
  'etapa?': "'nuevo' | 'respondido' | 'confirmado' | 'entregado' | 'perdido'",
  'motivoPerdida?': 'string <= 200',
  'mensajeEnviado?': '0 < string <= 2000',
  'items?': ItemFicha.array(),
  'cliente?': 'string | null', 'telefono?': 'string | null', 'direccion?': 'string | null',
  'asignado?': 'number | null',
  'nota?': '0 < string <= 1000',
  'posponerMin?': '1 <= number <= 10080',
  'quien?': 'string <= 60',
})

app.patch('/api/oportunidades/:id', async (c) => {
  const op = leerOportunidad(Number(c.req.param('id')))
  if (!op) return c.json({ error: 'No existe esa oportunidad.' }, 404)
  const cambio = Cambio(await c.req.json())
  if (cambio instanceof type.errors) return c.json({ error: cambio.summary }, 400)
  const t = ahora()
  const negocio = leerNegocio()
  const quien = cambio.quien || null
  const etapaAntes = op.etapa
  for (const k of ['cliente', 'telefono', 'direccion', 'motivoPerdida']) if (k in cambio) op[k] = cambio[k]
  if ('asignado' in cambio && cambio.asignado !== op.asignado) {
    op.asignado = cambio.asignado
    evento(op, `Reasignada a ${negocio.usuarios.find((u) => u.id === cambio.asignado)?.nombre ?? 'nadie'}.`, quien)
  }
  if (cambio.nota) evento(op, `Nota: ${cambio.nota}`, quien)
  if (cambio.items) Object.assign(op, conPrecios({ ...op, items: cambio.items }, leerNegocio()))
  if (cambio.mensajeEnviado) {
    op.mensajes = [...(op.mensajes || []), { de: 'negocio', texto: cambio.mensajeEnviado, fecha: t }]
    op.ultimaActividad = t
    if (op.etapa === 'nuevo' && !cambio.etapa) cambio.etapa = 'respondido'
    evento(op, 'Se le respondió al cliente.', quien)
  }
  if (cambio.etapa && cambio.etapa !== op.etapa) {
    op.historial = [...(op.historial || []), { etapa: cambio.etapa, fecha: t }]
    if (op.etapa === 'nuevo' && !op.primeraRespuesta) op.primeraRespuesta = t
    op.etapa = cambio.etapa
    op.ultimaActividad = t
    evento(op, `Estado: ${etapaAntes} → ${cambio.etapa}${cambio.etapa === 'perdido' && op.motivoPerdida ? ` (${op.motivoPerdida})` : ''}.`, quien)
  }
  // Cualquier movimiento reinicia el reloj de avisos; posponer lo corre a mano. Cerrada: sin avisos.
  if (!ABIERTAS.includes(op.etapa)) op.proximoAviso = null
  else if (cambio.posponerMin) {
    op.proximoAviso = enMinutos(cambio.posponerMin)
    evento(op, `Seguimiento agendado en ${cambio.posponerMin >= 60 ? Math.round(cambio.posponerMin / 6) / 10 + ' h' : cambio.posponerMin + ' min'}.`, quien)
  } else if (cambio.mensajeEnviado || cambio.etapa || cambio.nota) {
    op.proximoAviso = enMinutos(negocio.recordatorioMin ?? 15)
    op.avisosDados = 0
  }
  guardarOportunidad(op)
  return c.json(leerOportunidad(op.id))
})

app.delete('/api/oportunidades/:id', (c) => {
  db.prepare('DELETE FROM oportunidades WHERE id = ?').run(Number(c.req.param('id')))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// 5. Redactar: la primera respuesta o el mensaje para rescatar una venta que se enfría.
// ---------------------------------------------------------------------------
const Redaccion = type({ analisis: 'string', mensaje: 'string' })
const formatoRedaccion = formato(Redaccion, 'redaccion')

const PROMPT_REDACCION = (n, modo) => `${voz(n)}
Te paso en JSON una oportunidad de venta con los mensajes del cliente, los productos (con precio del catálogo o null) y las horas que pasaron sin respuesta.

${modo === 'confirmar'
    ? `Objetivo: el cliente hizo un pedido por teléfono o en el mostrador y ahora le escribís por WhatsApp para dejarlo confirmado por escrito.
- Saludá por el nombre y decí que le escribís de ${n.nombre} por el pedido que hizo.
- Detallá los productos con cantidades, precio unitario si lo hay y el total con formato $12.345 (si alguno no tiene precio, que se lo confirmás).
- Si faltan datos (faltaInfo), preguntalos (como mucho 2).
- Terminá pidiéndole que responda "SÍ" para confirmar el pedido y empezar a prepararlo.`
    : modo === 'rescate'
    ? `Objetivo: RESCATAR esta venta que se está enfriando. El cliente escribió hace rato y puede estar comprándole a otro.
- Abrí pidiendo disculpas breves por la demora si nadie le contestó, sin excusas largas.
- Nombrá lo que pidió (los productos concretos) y, si hay total, el total con formato $12.345.
- Si faltan datos (faltaInfo), hacé la pregunta más importante.
- Cerrá con una pregunta fácil de contestar que lo lleve a confirmar (ej. "¿Te lo separo?" o "¿Te lo mando hoy a la tarde?").`
    : `Objetivo: la primera respuesta, rápida y que lleve a cerrar la venta.
- Confirmá lo que pidió. Si hay productos con precio, poné precio unitario y el total con formato $12.345.
- Si un producto tiene precio null, decí que se lo confirmás en un ratito.
- Hacé las preguntas de faltaInfo (como mucho 3).
- Cerrá con una pregunta que lo lleve a confirmar.`}
- Español rioplatense, cálido, corto: de 3 a 6 líneas. Podés usar 1 emoji como mucho.
- Usá el nombre del cliente si lo sabés.
- Nunca inventes precios, descuentos, stock, horarios ni promociones que no estén en el JSON.
- El total es solo de los productos: no digas que incluye el envío.
- analisis: una frase sobre la estrategia del mensaje. mensaje: solo el texto listo para mandar.`

app.post('/api/oportunidades/:id/redactar', async (c) => {
  const op = leerOportunidad(Number(c.req.param('id')))
  if (!op) return c.json({ error: 'No existe esa oportunidad.' }, 404)
  const negocio = leerNegocio()
  const modo = ['rescate', 'confirmar'].includes(c.req.query('modo')) ? c.req.query('modo') : 'respuesta'
  const resumen = {
    cliente: op.cliente, tipo: op.tipo, entrega: op.entrega, direccion: op.direccion, faltaInfo: op.faltaInfo,
    items: op.items.map(({ producto, cantidad, unidad, nota, precio, subtotal }) => ({ producto, cantidad, unidad, nota, precio, subtotal })),
    total: op.total || null, mensajes: (op.mensajes || []).slice(-6),
    horasSinRespuesta: Math.round(op.horasSinRespuesta),
  }
  const r = await pedirJSON(formatoRedaccion, [
    { role: 'system', content: PROMPT_REDACCION(negocio, modo) },
    { role: 'user', content: JSON.stringify(resumen) },
  ])
  return c.json({ ...r, whatsapp: linkWhatsapp(op.telefono, r.mensaje) })
})

// wa.me necesita el número internacional: 341 555-1234 → 5493415551234.
function linkWhatsapp(telefono, texto) {
  let d = String(telefono || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '549' + d
  else if (d.length === 12 && d.startsWith('54') && d[2] !== '9') d = '549' + d.slice(2)
  return `https://wa.me/${d.length >= 11 ? d : ''}?text=${encodeURIComponent(texto)}`
}

// ---------------------------------------------------------------------------
// 6. La página pública de pedidos (la del QR): el cliente chatea y cae directo al embudo.
// ---------------------------------------------------------------------------
const visitas = new Map()   // tope simple por IP: la key es compartida
function pasaTope(ip) {
  const t = Date.now()
  const v = (visitas.get(ip) || []).filter((x) => t - x < 10 * 60_000)
  v.push(t)
  visitas.set(ip, v)
  return v.length <= 30
}

const MensajePublico = type({
  'conversacion?': 'number | null',
  'texto?': '0 < string <= 2000',
  'imagen?': /^data:image\//,
})

app.get('/api/publico/negocio', (c) => {
  const n = leerNegocio()
  if (!n) return c.json({ error: 'Este negocio todavía no está configurado.' }, 404)
  return c.json({ nombre: n.nombre, rubro: n.rubro, emoji: n.emoji, saludo: n.saludo, ciudad: n.ciudad,
    color: n.color || '#0b6e4f', botNombre: n.botNombre || 'Asistente', palabraVenta: n.palabraVenta || 'pedido',
    catalogo: n.catalogo, ejemplo: n.ejemplos[0] || null })
})

// Atiende un mensaje de un cliente (web o WhatsApp): la IA lee toda la charla, actualiza la ficha
// y escribe la respuesta. La venta queda "nueva" hasta que alguien del negocio la tome.
async function atender({ negocio, op, canal, texto, imagen, telefono = null, nombre = null, origen }) {
  const mensajes = [...(op?.mensajes || []), { de: 'cliente', texto: texto || '[mandó una foto]', fecha: ahora() }]
  const historia = mensajes.filter((m) => m.de !== 'nota').slice(-12).map((m) => ({ role: m.de === 'cliente' ? 'user' : 'assistant', content: m.texto }))
  if (imagen) {
    historia[historia.length - 1] = { role: 'user', content: [
      { type: 'text', text: texto || 'Te mando una foto de lo que necesito:' },
      { type: 'image_url', image_url: { url: imagen } },
    ] }
  }
  const extra = telefono ? `\nEl cliente escribe desde WhatsApp: su teléfono es ${telefono}${nombre ? ` y su nombre de perfil es "${nombre}"` : ''}. Usalos en la ficha y no se los pidas.` : ''
  // El pedido como lo calculó el sistema hasta ahora (precios del catálogo), para que el bot diga los números correctos.
  const estado = op?.items?.length ? `\n\nPedido hasta ahora, calculado por el sistema (usá estos precios tal cual):\n` +
    op.items.map((it) => `- ${it.cantidad} × ${it.producto}: ${it.precio == null ? 'sin precio' : `$${it.precio} c/u = $${it.subtotal}`}`).join('\n') +
    `\nTotal: $${op.total || 0}` : ''
  const r = await pedirJSON(formatoCharla, [{ role: 'system', content: PROMPT_CHARLA(negocio) + extra + estado }, ...historia])
  const { respuesta, clienteConfirmo, ...lectura } = r
  mensajes.push({ de: 'negocio', texto: respuesta, fecha: ahora(), ia: true })
  const nueva = { ...(op || {}), ...conPrecios(lectura, negocio), canal: op?.canal || canal, mensajes }
  if (telefono) nueva.telefono = telefono
  if (!nueva.cliente && nombre) nueva.cliente = nombre
  if (!op) nacer(nueva, negocio, origen)
  nueva.ultimaActividad = op?.ultimaActividad || ahora()
  // El cliente dijo que sí: la venta pasa sola a "confirmado" (recién ahí se prepara) y se le avisa al responsable.
  if (clienteConfirmo && nueva.items.length && ['nuevo', 'respondido'].includes(nueva.etapa)) {
    const t = ahora()
    nueva.historial = [...(nueva.historial || []), { etapa: 'confirmado', fecha: t }]
    if (!nueva.primeraRespuesta) nueva.primeraRespuesta = t
    evento(nueva, `✅ El cliente confirmó el pedido por ${origen}: ${pesos(nueva.total)}. A preparar.`)
    nueva.etapa = 'confirmado'
    nueva.ultimaActividad = t
    nueva.proximoAviso = null
    nueva.confirmadoPorCliente = t
  }
  const id = lectura.tipo === 'no_es_venta' && !op ? null : guardarOportunidad(nueva)
  if (id && nueva.confirmadoPorCliente && !op?.confirmadoPorCliente) {
    const destino = new Set([nueva.asignado, ...negocio.usuarios.filter((u) => u.rol === 'admin').map((u) => u.id)].filter(Boolean))
    for (const u of destino) insertarAviso.run(ahora(), u, id, `✅ ${nueva.cliente || 'Un cliente'} confirmó su pedido · ${pesos(nueva.total)} · a preparar`)
  }
  return { id, respuesta, nueva, lectura }
}

app.post('/api/publico/chat', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Este negocio todavía no está configurado.' }, 404)
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local'
  if (!pasaTope(ip)) return c.json({ error: 'Mandaste muchos mensajes seguidos. Esperá unos minutos.' }, 429)
  const body = MensajePublico(await c.req.json())
  if (body instanceof type.errors) return c.json({ error: 'El mensaje es muy largo o la imagen no es válida.' }, 400)
  if (!body.texto && !body.imagen) return c.json({ error: 'Escribí tu pedido o consulta.' }, 400)
  let op = body.conversacion ? leerOportunidad(body.conversacion) : null
  if (op && op.canal !== 'web') op = null
  const { id, respuesta, nueva, lectura } = await atender({ negocio, op, canal: 'web', texto: body.texto, imagen: body.imagen, origen: 'la web (QR)' })
  return c.json({ conversacion: id, respuesta, items: nueva.items, total: nueva.total, faltaInfo: lectura.faltaInfo })
})

// ---------------------------------------------------------------------------
// 6b. WhatsApp: el mismo webhook para la API real de Meta (Cloud API) y para el simulador (MOCK).
//     El simulador manda exactamente el JSON que manda Meta, así el camino del código es uno solo.
// ---------------------------------------------------------------------------
const GRAPH = 'https://graph.facebook.com/v21.0'
const mediaMock = new Map()   // id → { buffer, mime } (lo que el simulador "sube")
const registrarWa = db.prepare('INSERT OR IGNORE INTO wa_mensajes (fecha, telefono, de, texto, waid) VALUES (?, ?, ?, ?, ?)')
const soloDigitos = (t) => String(t || '').replace(/\D/g, '')
// Número internacional de WhatsApp: 341 555-2190 → 5493415552190 (así lo usa la Cloud API).
function telInt(t) {
  let d = soloDigitos(t)
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '549' + d
  else if (d.length === 12 && d.startsWith('54') && d[2] !== '9') d = '549' + d.slice(2)
  return d
}

function configWa(negocio) {
  const wa = negocio?.whatsapp || { modo: 'mock', autoResponder: true }
  return { ...wa, token: wa.token || process.env.WHATSAPP_TOKEN || null }
}

// Manda un texto por WhatsApp. En MOCK queda en la bandeja del simulador; en real va por la Cloud API.
async function enviarWhatsapp(negocio, telefono, texto) {
  const wa = configWa(negocio)
  const tel = telInt(telefono)
  if (!tel) throw new Error('Esta venta no tiene teléfono para mandarle un WhatsApp.')
  if (wa.modo === 'real') {
    const r = await fetch(`${GRAPH}/${wa.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wa.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: tel, type: 'text', text: { body: texto } }),
      signal: AbortSignal.timeout(10_000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`WhatsApp rechazó el mensaje: ${j.error?.message || r.status}`)
  }
  registrarWa.run(ahora(), tel, 'negocio', texto, null)
}

async function bajarMedia(negocio, id) {
  if (mediaMock.has(id)) return mediaMock.get(id)
  const wa = configWa(negocio)
  const meta = await (await fetch(`${GRAPH}/${id}`, { headers: { authorization: `Bearer ${wa.token}` } })).json()
  const r = await fetch(meta.url, { headers: { authorization: `Bearer ${wa.token}` } })
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: meta.mime_type || r.headers.get('content-type') }
}

async function transcribir(buffer, ext) {
  return conCache('audio:' + hash([MODEL_AUDIO, createHash('sha256').update(buffer).digest('hex')]), async () =>
    (await openai.audio.transcriptions.create({ file: await toFile(buffer, `audio.${ext}`), model: MODEL_AUDIO, language: 'es' })).text)
}

// Un mensaje entrante de WhatsApp (ya sacado del JSON de Meta).
async function recibirWhatsapp(negocio, m, contacto) {
  const tel = telInt(m.from)
  let texto = null, imagen = null
  if (m.type === 'text') texto = m.text?.body
  else if (m.type === 'audio') {
    const { buffer, mime } = await bajarMedia(negocio, m.audio.id)
    const ext = /mp4|m4a/.test(mime) ? 'mp4' : /mpeg|mp3/.test(mime) ? 'mp3' : /webm/.test(mime) ? 'webm' : 'ogg'
    texto = '🎤 ' + await transcribir(buffer, ext)
  } else if (m.type === 'image') {
    const { buffer, mime } = await bajarMedia(negocio, m.image.id)
    imagen = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`
    texto = m.image.caption || null
  } else texto = `[mandó un mensaje de tipo ${m.type}]`
  // waid único: si Meta reenvía el mismo mensaje, no se atiende dos veces.
  const nuevo = registrarWa.run(ahora(), tel, 'cliente', texto || '📷 [foto]', m.id || null).changes
  if (!nuevo) return

  // La venta abierta de este teléfono, o una nueva.
  // La venta abierta de este teléfono (venga de WhatsApp, de una llamada pasada al bot, etc.).
  const mismoTel = (o) => { const d = soloDigitos(o.telefono); return d && (d === tel || d.slice(-10) === tel.slice(-10)) }
  const op = listarOportunidades().find((o) => mismoTel(o) && ['nuevo', 'respondido'].includes(o.etapa)) || null
  const wa = configWa(negocio)
  if (!wa.autoResponder && !op?.bot) {
    // Sin respuesta automática: la IA igual arma la ficha, pero contesta una persona.
    const lectura = conPrecios(await pedirJSON(formatoLectura, [
      { role: 'system', content: PROMPT_LECTURA(negocio) },
      { role: 'user', content: [...(op?.mensajes || []).filter((x) => x.de === 'cliente').map((x) => x.texto), texto || '[foto]'].join('\n') },
    ]), negocio)
    const nueva = { ...(op || {}), ...lectura, canal: 'whatsapp', telefono: tel, cliente: lectura.cliente || op?.cliente || contacto?.profile?.name || null,
      mensajes: [...(op?.mensajes || []), { de: 'cliente', texto: texto || '[foto]', fecha: ahora() }] }
    if (!op) { nacer(nueva, negocio, 'WhatsApp'); nueva.ultimaActividad = ahora() }
    guardarOportunidad(nueva)
    return
  }
  const { respuesta } = await atender({ negocio, op, canal: 'whatsapp', texto, imagen, telefono: tel, nombre: contacto?.profile?.name, origen: 'WhatsApp' })
  await enviarWhatsapp(negocio, tel, respuesta)
}

// Verificación del webhook (Meta la pide una vez al configurarlo).
app.get('/webhook/whatsapp', (c) => {
  const wa = configWa(leerNegocio())
  if (c.req.query('hub.mode') === 'subscribe' && c.req.query('hub.verify_token') === wa.verifyToken) return c.text(c.req.query('hub.challenge') || '')
  return c.text('Token de verificación incorrecto', 403)
})

app.post('/webhook/whatsapp', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Negocio sin configurar.' }, 404)
  const crudo = await c.req.text()
  const wa = configWa(negocio)
  const esMock = c.req.header('x-mostrador-mock') === '1'
  if (esMock && wa.modo !== 'mock') return c.json({ error: 'El simulador está apagado: WhatsApp está en modo API real.' }, 409)
  // En modo real, si hay App Secret, se valida la firma de Meta.
  if (!esMock && wa.appSecret) {
    const firma = c.req.header('x-hub-signature-256') || ''
    const esperada = 'sha256=' + createHmac('sha256', wa.appSecret).update(crudo).digest('hex')
    if (firma.length !== esperada.length || !timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return c.text('Firma inválida', 401)
  }
  const cuerpo = JSON.parse(crudo)
  const tareas = []
  for (const entry of cuerpo.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {}
    for (const m of v.messages || []) {
      const contacto = (v.contacts || []).find((x) => x.wa_id === m.from) || v.contacts?.[0]
      tareas.push(recibirWhatsapp(negocio, m, contacto).catch((err) => {
        console.error('whatsapp:', err)
        registrarWa.run(ahora(), telInt(m.from), 'sistema', '⚠️ ' + (err instanceof OpenAI.RateLimitError ? 'La IA está saturada, te contestamos enseguida.' : 'No pudimos procesar el mensaje, te contestamos enseguida.'), null)
      }))
    }
  }
  // Meta espera un 200 rápido: en real se procesa de fondo. El simulador espera para mostrar todo junto.
  if (esMock) await Promise.all(tareas)
  return c.json({ ok: true })
})

// Simulador: "sube" un audio o una foto como lo haría WhatsApp, y lee la charla de un teléfono.
app.post('/api/wa-mock/media', async (c) => {
  const buffer = Buffer.from(await c.req.arrayBuffer())
  if (!buffer.length || buffer.length > 16 * 1024 * 1024) return c.json({ error: 'El archivo está vacío o pesa más de 16 MB.' }, 400)
  const id = 'mock-' + createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  mediaMock.set(id, { buffer, mime: c.req.header('content-type') || 'application/octet-stream' })
  return c.json({ id })
})
app.get('/api/wa-mock/chat', (c) => {
  const tel = telInt(c.req.query('telefono'))
  return c.json(db.prepare('SELECT id, fecha, de, texto FROM wa_mensajes WHERE telefono = ? ORDER BY id').all(tel))
})
app.get('/api/wa/estado', (c) => {
  const n = leerNegocio()
  const wa = configWa(n)
  return c.json({ modo: wa.modo, autoResponder: wa.autoResponder, negocio: n?.nombre, emoji: n?.emoji,
    color: n?.color || '#008069', botNombre: n?.botNombre || null, listo: wa.modo === 'mock' || !!(wa.token && wa.phoneNumberId) })
})

// Mandar desde el CRM por WhatsApp (MOCK → aparece en el simulador; real → Cloud API).
app.post('/api/oportunidades/:id/enviar', async (c) => {
  const op = leerOportunidad(Number(c.req.param('id')))
  if (!op) return c.json({ error: 'No existe esa oportunidad.' }, 404)
  const { mensaje, quien } = await c.req.json()
  if (!mensaje?.trim()) return c.json({ error: 'El mensaje está vacío.' }, 400)
  await enviarWhatsapp(leerNegocio(), op.telefono, mensaje.trim())
  return c.json({ ok: true, modo: configWa(leerNegocio()).modo })
})

// ---------------------------------------------------------------------------
// 6c. "Pasarle al bot": el empleado anota en dos palabras lo que le pidieron (por teléfono, en el mostrador)
//     y la IA arma la venta, le escribe al cliente por WhatsApp para confirmarla y sigue la charla sola.
// ---------------------------------------------------------------------------
const PasarAlBot = type({ texto: '0 < string <= 2000', canal: 'string', 'quien?': 'string <= 60' })

app.post('/api/bot/tomar', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  const body = PasarAlBot(await c.req.json())
  if (body instanceof type.errors) return c.json({ error: 'Escribí en pocas palabras qué pidió y el teléfono del cliente.' }, 400)
  const lectura = conPrecios(await pedirJSON(formatoLectura, [
    { role: 'system', content: PROMPT_LECTURA(negocio) + '\n\nOjo: el texto es una nota rápida que escribió un empleado (no el cliente), con lo que el cliente pidió por teléfono o en el local.' },
    { role: 'user', content: body.texto },
  ]), negocio)
  if (lectura.tipo === 'no_es_venta' || !lectura.items.length) return c.json({ error: `No encontré un pedido en la nota: ${lectura.analisis}` }, 422)
  if (!soloDigitos(lectura.telefono)) return c.json({ error: 'Para que el bot le escriba, la nota tiene que tener el teléfono del cliente.', ficha: lectura }, 422)

  const op = { ...lectura, canal: CANALES.includes(body.canal) ? body.canal : 'telefono', ultimaActividad: ahora(), bot: true,
    mensajes: [{ de: 'nota', texto: `📝 ${body.quien || 'Empleado'}: ${body.texto}`, fecha: ahora() }] }
  nacer(op, negocio, `${op.canal} (pasada al bot por ${body.quien || 'un empleado'})`)
  const id = guardarOportunidad(op)

  const guardada = leerOportunidad(id)
  const resumen = {
    cliente: guardada.cliente, tipo: guardada.tipo, entrega: guardada.entrega, direccion: guardada.direccion, faltaInfo: guardada.faltaInfo,
    items: guardada.items.map(({ producto, cantidad, unidad, nota, precio, subtotal }) => ({ producto, cantidad, unidad, nota, precio, subtotal })),
    total: guardada.total || null,
  }
  const { mensaje } = await pedirJSON(formatoRedaccion, [
    { role: 'system', content: PROMPT_REDACCION(negocio, 'confirmar') },
    { role: 'user', content: JSON.stringify(resumen) },
  ])
  await enviarWhatsapp(negocio, guardada.telefono, mensaje)
  const t = ahora()
  guardada.mensajes = [...guardada.mensajes, { de: 'negocio', texto: mensaje, fecha: t, ia: true }]
  guardada.historial = [...guardada.historial, { etapa: 'respondido', fecha: t }]
  guardada.primeraRespuesta = t
  guardada.etapa = 'respondido'
  guardada.ultimaActividad = t
  evento(guardada, '🤖 El bot le escribió por WhatsApp para confirmar el pedido.')
  guardarOportunidad(guardada)
  return c.json(leerOportunidad(id), 201)
})

// ---------------------------------------------------------------------------
// 7. Tablero: plata en juego, plata en riesgo, embudo y canales.
// ---------------------------------------------------------------------------
app.get('/api/tablero', (c) => {
  const ops = listarOportunidades().filter((o) => o.tipo !== 'no_es_venta')
  const suma = (lista) => lista.reduce((s, o) => s + (o.total || 0), 0)
  const abiertas = ops.filter((o) => ABIERTAS.includes(o.etapa))
  const ganadas = ops.filter((o) => ['confirmado', 'entregado'].includes(o.etapa))
  const perdidas = ops.filter((o) => o.etapa === 'perdido')
  const enRiesgo = ops.filter((o) => o.enRiesgo)
  const respuestas = ops.filter((o) => o.primeraRespuesta).map((o) => (new Date(o.primeraRespuesta) - new Date(o.creado)) / 60_000)
  const cerradas = ganadas.length + perdidas.length

  const dias = [...Array(7)].map((_, i) => {
    const d = new Date(Date.now() - (6 - i) * 864e5)
    return d.toISOString().slice(0, 10)
  })
  const porDia = dias.map((dia) => ({
    dia,
    entrantes: ops.filter((o) => o.creado.slice(0, 10) === dia).length,
    ganadas: ganadas.filter((o) => (o.historial || []).some((h) => ['confirmado', 'entregado'].includes(h.etapa) && h.fecha.slice(0, 10) === dia)).length,
  }))
  const productos = {}
  for (const o of ops) for (const it of o.items || []) {
    productos[it.producto] ??= { producto: it.producto, pedidos: 0, monto: 0 }
    productos[it.producto].pedidos++
    productos[it.producto].monto += it.subtotal || 0
  }
  const pendientesPrecio = {}
  for (const o of abiertas) for (const it of o.items || []) if (!it.enCatalogo) pendientesPrecio[it.producto] = (pendientesPrecio[it.producto] || 0) + 1

  return c.json({
    kpis: {
      enJuego: suma(abiertas), ganado: suma(ganadas), perdido: suma(perdidas), enRiesgo: suma(enRiesgo),
      cantidadEnRiesgo: enRiesgo.length, abiertas: abiertas.length,
      conversion: cerradas ? Math.round((ganadas.length / cerradas) * 100) : null,
      respuestaMin: respuestas.length ? Math.round(respuestas.reduce((a, b) => a + b, 0) / respuestas.length) : null,
    },
    porEtapa: ETAPAS.map((e) => ({ etapa: e, cantidad: ops.filter((o) => o.etapa === e).length, monto: suma(ops.filter((o) => o.etapa === e)) })),
    porCanal: CANALES.map((canal) => ({ canal, cantidad: ops.filter((o) => o.canal === canal).length })).filter((x) => x.cantidad),
    porDia,
    topProductos: Object.values(productos).sort((a, b) => b.pedidos - a.pedidos).slice(0, 8),
    // Lo que piden y no está en el catálogo: demanda que el negocio no está viendo.
    sinCatalogo: Object.entries(pendientesPrecio).map(([producto, veces]) => ({ producto, veces })).sort((a, b) => b.veces - a.veces).slice(0, 6),
    motivosPerdida: Object.entries(perdidas.reduce((m, o) => ((m[o.motivoPerdida || 'Sin motivo'] = (m[o.motivoPerdida || 'Sin motivo'] || 0) + 1), m), {}))
      .map(([motivo, veces]) => ({ motivo, veces })),
  })
})

// ---------------------------------------------------------------------------
// 8. Prioridades del día: la IA mira el embudo y dice por dónde empezar.
// ---------------------------------------------------------------------------
const Prioridades = type({
  analisis: 'string',
  prioridades: type({ accion: 'string', id: 'number', porque: 'string' }).array(),
})
const formatoPrioridades = formato(Prioridades, 'prioridades')

app.post('/api/prioridades', async (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  const abiertas = listarOportunidades().filter((o) => ABIERTAS.includes(o.etapa) && o.tipo !== 'no_es_venta')
  if (!abiertas.length) return c.json({ analisis: 'No hay ventas abiertas. ¡Está todo al día!', prioridades: [] })
  const datos = abiertas.slice(0, 30).map((o) => ({
    id: o.id, cliente: o.cliente, etapa: o.etapa, tipo: o.tipo, resumen: o.resumen, total: o.total, probabilidad: o.probabilidad,
    urgencia: o.urgencia, horasSinRespuesta: Math.round(o.horasSinRespuesta), enRiesgo: o.enRiesgo, faltaInfo: o.faltaInfo.length,
  }))
  const r = await pedirJSON(formatoPrioridades, [
    { role: 'system', content: `Sos el gerente de ventas de ${negocio.nombre} (${negocio.rubro}). Un cliente de este rubro espera como mucho ${negocio.enfriaHoras} horas antes de comprarle a otro. Te paso las ventas abiertas en JSON.
- prioridades: las 3 ventas que hay que atender primero (o menos si hay menos), ordenadas. Priorizá plata en juego × probabilidad, las que están en riesgo y las urgentes. id: el id exacto del JSON.
- accion: qué hacer, en una frase completa con verbo, el nombre del cliente y el producto (ej. "Escribirle a Lucas Ferreyra para cerrar los 2 taladros"). Nunca una sola palabra.
- porque: en una frase, con números concretos del JSON (total con formato $12.345, horas sin respuesta).
- analisis: una frase con el diagnóstico del día (cuánta plata hay en riesgo, con formato $12.345, y qué patrón ves).
- No inventes ids ni montos.` },
    { role: 'user', content: JSON.stringify(datos) },
  ])
  const ids = new Set(abiertas.map((o) => o.id))
  const vistos = new Set()
  return c.json({ ...r, prioridades: r.prioridades.filter((p) => ids.has(p.id) && !vistos.has(p.id) && vistos.add(p.id)).slice(0, 3) })
})

// ---------------------------------------------------------------------------
// 9. Avisos: cada venta abierta le avisa a su responsable cada `recordatorioMin` minutos
//    hasta que alguien la mueva. Después de `escalarTras` avisos sin respuesta, también al admin.
// ---------------------------------------------------------------------------
const pesos = (n) => '$' + Math.round(n).toLocaleString('es-AR')
const insertarAviso = db.prepare('INSERT INTO avisos (creado, usuario, oportunidad, texto) VALUES (?, ?, ?, ?)')

function revisarAvisos() {
  const negocio = leerNegocio()
  if (!negocio) return
  const admins = negocio.usuarios.filter((u) => u.rol === 'admin').map((u) => u.id)
  for (const op of listarOportunidades()) {
    if (!op.avisoVencido || op.tipo === 'no_es_venta') continue
    op.avisosDados = (op.avisosDados || 0) + 1
    op.proximoAviso = enMinutos(negocio.recordatorioMin ?? 15)
    const h = op.horasSinRespuesta
    const espera = h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h * 10) / 10} h`
    const texto = `${op.cliente || 'Un cliente'} espera hace ${espera}` + (op.total ? ` · ${pesos(op.total)} en juego` : '') +
      ` · ${op.resumen || op.tipo} (aviso ${op.avisosDados})`
    const destino = new Set(op.asignado ? [op.asignado] : admins)
    if (op.avisosDados > (negocio.escalarTras ?? 2)) admins.forEach((a) => destino.add(a))
    for (const u of destino) insertarAviso.run(ahora(), u, op.id, texto)
    evento(op, `Aviso ${op.avisosDados} a ${[...destino].map((u) => negocio.usuarios.find((x) => x.id === u)?.nombre).filter(Boolean).join(' y ')}.`)
    // Guarda sin tocar `actualizado`: un aviso no es actividad del negocio.
    const { id, creado, actualizado, etapa, horasSinRespuesta, enRiesgo, responsable, avisoVencido, ...datos } = op
    db.prepare('UPDATE oportunidades SET datos = ? WHERE id = ?').run(JSON.stringify(datos), id)
  }
}
setInterval(revisarAvisos, 20_000).unref()

// Los avisos nuevos de un usuario (la página pregunta cada 15 s y dispara la notificación del navegador).
app.get('/api/avisos', (c) => {
  revisarAvisos()
  const usuario = Number(c.req.query('usuario'))
  const desde = Number(c.req.query('desde')) || 0
  const negocio = leerNegocio()
  const filas = db.prepare('SELECT * FROM avisos WHERE usuario = ? AND id > ? ORDER BY id DESC LIMIT 30').all(usuario, desde)
  const u = negocio?.usuarios?.find((x) => x.id === usuario)
  return c.json(filas.map((a) => ({ ...a, whatsapp: u?.telefono ? linkWhatsapp(u.telefono, `⏰ Mostrador: ${a.texto}`) : null })))
})

// ---------------------------------------------------------------------------
// Datos de ejemplo (sin IA): para que el tablero no arranque vacío en la demo.
// ---------------------------------------------------------------------------
function cargarEjemplos(negocio) {
  const gente = [
    ['Marta Gómez', '341 555-2190', 'Córdoba 1850'], ['Lucas Ferreyra', '341 612-4431', null], ['Sofía Ruiz', '341 577-9012', 'Mendoza 3320'],
    ['Ramón Ibáñez', '341 640-1187', 'Oroño 1450'], ['Carla Benítez', null, null], ['Julián Paz', '341 598-3376', 'San Juan 2440'],
    ['Paula Acosta', '341 603-7788', null], ['Ezequiel Mansilla', '341 588-2201', 'Pellegrini 980'], ['Norma Villalba', '341 534-6620', 'Rioja 2105'],
    ['Diego Sosa', '341 620-1543', null],
  ]
  const plan = [   // [etapa, horas atrás, canal, motivo]
    ['nuevo', negocio.enfriaHoras * 3, 'whatsapp'], ['nuevo', negocio.enfriaHoras * 1.6, 'telefono'], ['nuevo', 0.1, 'whatsapp'],
    ['respondido', negocio.enfriaHoras * 2.2, 'whatsapp'], ['respondido', 0.5, 'instagram'], ['confirmado', 20, 'whatsapp'],
    ['entregado', 50, 'telefono'], ['entregado', 98, 'whatsapp'], ['perdido', 75, 'whatsapp', 'Le respondimos tarde'],
    ['perdido', 130, 'telefono', 'Precio'],
  ]
  const conPrecio = negocio.catalogo.filter((p) => p.precio != null)
  const fuente = conPrecio.length >= 3 ? conPrecio : negocio.catalogo
  plan.forEach(([etapa, horas, canal, motivo], i) => {
    const [cliente, telefono, direccion] = gente[i]
    const items = [0, 1, 2].slice(0, 1 + (i % 3)).map((k) => {
      const p = fuente[(i * 3 + k * 5) % fuente.length]
      return { producto: p.producto, cantidad: 1 + ((i + k) % 4), enCatalogo: true, nota: null }
    })
    const creado = new Date(Date.now() - horas * 36e5).toISOString()
    const historial = [{ etapa: 'nuevo', fecha: creado }]
    let primeraRespuesta = null
    const pasos = { respondido: 1, confirmado: 2, entregado: 3, perdido: 1 }[etapa] || 0
    const siguientes = ['respondido', 'confirmado', 'entregado']
    for (let k = 0; k < pasos; k++) {
      const fecha = new Date(new Date(creado).getTime() + (k + 1) * (horas * 0.15) * 36e5).toISOString()
      historial.push({ etapa: siguientes[k], fecha })
      if (k === 0) primeraRespuesta = fecha
    }
    if (etapa === 'perdido') historial.push({ etapa: 'perdido', fecha: new Date(new Date(creado).getTime() + horas * 0.5 * 36e5).toISOString() })
    const ultima = historial.at(-1).fecha
    const op = conPrecios({
      analisis: 'Dato de ejemplo cargado para la demo.', cliente, telefono, direccion, entrega: direccion ? 'envio' : 'retiro',
      faltaInfo: etapa === 'nuevo' && i === 1 ? ['¿Qué cantidad necesitás?'] : [], items, probabilidad: [80, 55, 70, 60, 45, 90, 95, 90, 30, 20][i],
      proximaAccion: etapa === 'nuevo' ? 'Responderle con el total y confirmar la entrega' : 'Hacer el seguimiento',
      resumen: items.map((it) => `${it.cantidad} ${it.producto}`).join(' + ').slice(0, 60),
      tipo: i % 4 === 3 ? 'presupuesto' : 'pedido', urgencia: i < 3 ? 'alta' : 'media',
    }, negocio)
    // Venta de demo con un producto sin precio: se le pone un precio de demo para que el tablero muestre plata real.
    op.items = op.items.map((it, k) => it.precio != null ? it : { ...it, precio: [2500, 4800, 7200, 9900, 15000, 22000][(i + k) % 6], subtotal: null })
      .map((it) => ({ ...it, subtotal: Math.round(it.precio * it.cantidad) }))
    op.total = op.items.reduce((t, it) => t + it.subtotal, 0)
    op.sinPrecio = 0
    Object.assign(op, {
      canal, etapa, historial, primeraRespuesta, ultimaActividad: ultima, motivoPerdida: motivo || null, ejemplo: true,
      asignado: negocio.usuarios[i % negocio.usuarios.length].id, avisosDados: 0,
      // Las abiertas viejas ya tienen el aviso vencido: en la demo suenan enseguida.
      proximoAviso: ABIERTAS.includes(etapa) ? (horas > 1 ? ahora() : enMinutos(negocio.recordatorioMin ?? 15)) : null,
      eventos: historial.map((h, k) => ({ fecha: h.fecha, texto: k ? `Estado: ${historial[k - 1].etapa} → ${h.etapa}.` : `Entró por ${canal}.`, quien: null })),
      mensajes: [{ de: 'cliente', texto: `Hola! Soy ${cliente.split(' ')[0]}, quería ${op.resumen.toLowerCase()}.`, fecha: creado }],
      creado, actualizado: ultima,
    })
    guardarOportunidad(op)
  })
}

app.post('/api/ejemplos', (c) => {
  const negocio = leerNegocio()
  if (!negocio) return c.json({ error: 'Primero creá el negocio.' }, 400)
  cargarEjemplos(negocio)
  return c.json({ ok: true }, 201)
})

app.use('/*', serveStatic({ root: './public' }))

app.onError((err, c) => {
  console.error(err)
  if (err instanceof OpenAI.RateLimitError) {
    const error = err.code === 'insufficient_quota'
      ? 'La key de OpenAI se quedó sin crédito.'
      : 'La IA está saturada. Probá de nuevo en unos segundos.'
    return c.json({ error }, 429)
  }
  if (err instanceof OpenAI.AuthenticationError) return c.json({ error: 'La key de OpenAI es inválida: revisá OPENAI_API_KEY en el .env.' }, 502)
  if (err instanceof OpenAI.NotFoundError) return c.json({ error: `El modelo ${MODEL} no está disponible para esta key.` }, 502)
  if (err instanceof OpenAI.APIError) return c.json({ error: 'La IA no respondió. Probá de nuevo.' }, 502)
  if (/Standard Schema validation failed/.test(err.message)) return c.json({ error: 'La IA devolvió algo que no pasó la validación. Probá de nuevo.' }, 502)
  if (err instanceof SyntaxError) return c.json({ error: 'El pedido llegó mal armado.' }, 400)
  return c.json({ error: 'Algo falló. Probá de nuevo.' }, 500)
})

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3000 }, (i) =>
  console.log(`http://localhost:${i.port} (modelo ${MODEL})`))
