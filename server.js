/**
 * Servidor 1vs1 en tiempo real para "Millonario IA" (B4A).
 *
 * Protocolo: HTTP Polling REST (lo que usa Online.bas con OkHttp).
 *   POST /api/buscar      -> { nombre }          -> { jugadorId }
 *   GET  /api/estado?jugador=<id>  -> evento pendiente o { tipo:"nada" }
 *   POST /api/respuesta   -> { jugador, eleccion } -> {}
 *   POST /api/comodin     -> { jugador, comodin }  -> resultado del comodín
 *
 * Empareja 2 jugadores, valida respuestas del lado del servidor
 * (anti-trampa), controla el tiempo por pregunta y anuncia al ganador.
 *
 * Desplegar:
 *   cd servidor
 *   npm install
 *   node server.js
 */
const http = require('http');
const { URL } = require('url');

const HTTP_PORT = process.env.PORT || 3000;

// ==================== Banco de preguntas ====================
const BANCO = [
  { texto: '¿Cuál es la capital de Francia?', opciones: ['Berlín', 'Madrid', 'París', 'Roma'], correcta: 2, puntos: 100 },
  { texto: '¿Cuánto es 7 x 8?', opciones: ['54', '56', '48', '64'], correcta: 1, puntos: 100 },
  { texto: '¿Qué planeta es conocido como el Planeta Rojo?', opciones: ['Venus', 'Marte', 'Júpiter', 'Saturno'], correcta: 1, puntos: 100 },
  { texto: '¿Quién pintó la Mona Lisa?', opciones: ['Van Gogh', 'Picasso', 'Leonardo da Vinci', 'Miguel Ángel'], correcta: 2, puntos: 100 },
  { texto: '¿Cuántos lados tiene un hexágono?', opciones: ['4', '5', '6', '8'], correcta: 2, puntos: 100 },
  { texto: '¿Cuál es el océano más grande?', opciones: ['Atlántico', 'Índico', 'Ártico', 'Pacífico'], correcta: 3, puntos: 100 },
  { texto: '¿En qué año llegó el hombre a la luna?', opciones: ['1965', '1969', '1972', '1959'], correcta: 1, puntos: 100 },
  { texto: '¿Cuál es el país más poblado del mundo?', opciones: ['India', 'EE.UU.', 'China', 'Brasil'], correcta: 0, puntos: 100 }
];

const PREGUNTAS_POR_PARTIDA = 3;     // cantidad de preguntas por partida
const TIEMPO_PREGUNTA = 15000;       // límite por pregunta (ms)
const TIEMPO_ABANDONO = 20000;       // sin polling durante este tiempo = abandono

// ==================== Estado ====================
let idJugadorSiguiente = 1;          // id creciente de jugador
let idPartidaSiguiente = 1;          // id creciente de partida
const jugadores = {};                // jugadorId -> { id, nombre, lastSeen }
const listaEspera = [];              // ids de jugadores esperando rival
const partidas = {};                 // partidaId -> partida

// ==================== Utilidades ====================
function barajar(arr) {
  const copia = arr.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

function tocar(jugador) {
  jugador.lastSeen = Date.now();
}

function encolar(jugador, mensaje) {
  if (!jugador.cola) jugador.cola = [];
  jugador.cola.push(mensaje);
}

// ==================== Emparejamiento ====================
function crearPartida(jA, jB) {
  idPartidaSiguiente++;
  const partidaId = 'm' + idPartidaSiguiente;
  const preguntas = barajar(BANCO).slice(0, PREGUNTAS_POR_PARTIDA);

  const partida = {
    id: partidaId,
    preguntas,
    indice: -1,
    turno: null,
    timeoutObj: null,
    jugadores: [
      { jugador: jA, sessionId: 'A', puntaje: 0, eleccion: null, dejaJugar: false },
      { jugador: jB, sessionId: 'B', puntaje: 0, eleccion: null, dejaJugar: false }
    ]
  };
  partidas[partidaId] = partida;

  jA.partida = partidaId;
  jB.partida = partidaId;

  const datosA = { partida: partidaId, sessionId: 'A', total: preguntas.length, nombreRival: jB.nombre };
  const datosB = { partida: partidaId, sessionId: 'B', total: preguntas.length, nombreRival: jA.nombre };
  encolar(jA, Object.assign({ tipo: 'partida' }, datosA));
  encolar(jB, Object.assign({ tipo: 'partida' }, datosB));

  // Primera pregunta con un pequeño margen para que carguen las pantallas
  setTimeout(() => siguientePregunta(partidaId), 1200);
}

function buscar(nombre) {
  idJugadorSiguiente++;
  const jugador = { id: String(idJugadorSiguiente), nombre: nombre || 'Jugador', cola: [], partida: null };
  jugadores[jugador.id] = jugador;
  tocar(jugador);

  if (listaEspera.length > 0) {
    const idRival = listaEspera.shift();
    const rival = jugadores[idRival];
    crearPartida(rival, jugador);
  } else {
    listaEspera.push(jugador.id);
  }

  return { jugadorId: jugador.id };
}

// ==================== Progreso de la partida ====================
function siguientePregunta(partidaId) {
  const partida = partidas[partidaId];
  if (!partida) return;

  partida.indice++;
  if (partida.indice >= partida.preguntas.length) {
    terminar(partidaId);
    return;
  }

  for (const j of partida.jugadores) {
    j.eleccion = null;
  }
  partida.turno = Date.now() + TIEMPO_PREGUNTA;
  if (partida.timeoutObj) clearTimeout(partida.timeoutObj);
  partida.timeoutObj = setTimeout(() => resolverPorTiempo(partidaId), TIEMPO_PREGUNTA);

  const p = partida.preguntas[partida.indice];
  const payload = {
    tipo: 'pregunta',
    partida: partidaId,
    num: partida.indice + 1,
    total: partida.preguntas.length,
    texto: p.texto,
    opciones: p.opciones,
    premio: p.puntos * (partida.indice + 1),
    tiempo: TIEMPO_PREGUNTA / 1000
  };
  encolar(partida.jugadores[0].jugador, payload);
  encolar(partida.jugadores[1].jugador, payload);
}

function resolver(partidaId, porTiempo) {
  const partida = partidas[partidaId];
  if (!partida || !partida.turno) return;
  partida.turno = null;
  if (partida.timeoutObj) clearTimeout(partida.timeoutObj);

  const p = partida.preguntas[partida.indice];
  for (const j of partida.jugadores) {
    const correcto = !porTiempo && j.eleccion === p.correcta;
    if (correcto) j.puntaje += p.puntos;
    const mensaje = porTiempo
      ? { tipo: 'resultadoRespuestaPorTiempo', correcta: p.correcta }
      : { tipo: 'resultadoRespuesta', correcta: p.correcta, acerto: correcto, puntosGanados: correcto ? p.puntos : 0 };
    encolar(j.jugador, mensaje);
  }

  // Ambas apps leen el resultado por polling y luego llega la siguiente
  setTimeout(() => siguientePregunta(partidaId), 1500);
}

function resolverPorTiempo(partidaId) {
  resolver(partidaId, true);
}

// ==================== Terminar partida ====================
function terminar(partidaId) {
  const partida = partidas[partidaId];
  if (!partida) return;
  if (partida.timeoutObj) clearTimeout(partida.timeoutObj);

  const a = partida.jugadores[0];
  const b = partida.jugadores[1];
  let ganador = null;
  if (a.puntaje > b.puntaje) ganador = a.sessionId;
  else if (b.puntaje > a.puntaje) ganador = b.sessionId;
  // empate -> nulo

  const res = { partida: partidaId, puntajeA: a.puntaje, puntajeB: b.puntaje, ganador };
  encolar(a.jugador, Object.assign({ tipo: 'fin' }, res));
  encolar(b.jugador, Object.assign({ tipo: 'fin' }, res));

  a.jugador.partida = null;
  b.jugador.partida = null;
  delete partidas[partidaId];
}

function abandonar(jugador) {
  // El rival gana; el que abandonó ya no recibe el "fin".
  const partida = partidas[jugador.partida];
  if (!partida) return;
  const otro = partida.jugadores.find(j => j.jugador.id !== jugador.id);
  if (otro) {
    encolar(otro.jugador, {
      tipo: 'fin',
      partida: partida.id,
      ganador: otro.sessionId,
      abandono: true,
      puntajeA: partida.jugadores[0].puntaje,
      puntajeB: partida.jugadores[1].puntaje
    });
    otro.jugador.partida = null;
  }
  if (partida.timeoutObj) clearTimeout(partida.timeoutObj);
  delete partidas[partida.id];
}

// ==================== Comodines ====================
function usarComodin(jugador, tipoComodin) {
  const partida = partidas[jugador.partida];
  if (!partida || partida.indice < 0) return { error: 'No hay pregunta activa' };
  const p = partida.preguntas[partida.indice];

  if (tipoComodin === '5050') {
    const opciones = [0, 1, 2, 3].filter(i => i !== p.correcta);
    const a = opciones[Math.floor(Math.random() * opciones.length)];
    const b = opciones.find(x => x !== a);
    return { tipo: 'comodin5050', eliminadas: [a, b] };
  }

  if (tipoComodin === 'llamar') {
    const letras = ['A', 'B', 'C', 'D'];
    const mensajes = [
      'Tu amigo cree que la respuesta correcta es la ' + letras[p.correcta] + '.',
      '¡Estoy casi seguro! Marca la opción ' + letras[p.correcta] + '.',
      'Mmm... yo me iría por la ' + letras[p.correcta] + '.'
    ];
    return { tipo: 'comodinLlamar', mensaje: mensajes[Math.floor(Math.random() * mensajes.length)] };
  }

  if (tipoComodin === 'publico') {
    const votos = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) votos[i] = 4;
    votos[p.correcta] = 72;
    votos[Math.floor(Math.random() * 4)] += 16;
    const suma = votos.reduce((s, v) => s + v, 0);
    return {
      tipo: 'comodinPublico',
      votos: votos.map((v, i) => ({ opcion: i, porcentaje: Math.round((v / suma) * 100) }))
    };
  }

  return { error: 'Comodín desconocido' };
}

// ==================== Detección de abandono ====================
setInterval(() => {
  const ahora = Date.now();
  for (const id in jugadores) {
    const j = jugadores[id];
    if (j.partida && partidas[j.partida]) {
      if (ahora - j.lastSeen > TIEMPO_ABANDONO) {
        abandonar(j);
      }
    }
  }
  // Limpieza de jugadores que ya no están en ninguna partida ni espera
  for (const id in jugadores) {
    const j = jugadores[id];
    if (!j.partida && listaEspera.indexOf(id) === -1 && ahora - j.lastSeen > TIEMPO_ABANDONO) {
      delete jugadores[id];
    }
  }
}, 3000);

// ==================== Servidor HTTP (REST) ====================
function leerCuerpo(req, cb) {
  let datos = '';
  req.on('data', (chunk) => { datos += chunk; });
  req.on('end', () => {
    try { cb(datos ? JSON.parse(datos) : {}); }
    catch (e) { cb({}); }
  });
  req.on('error', () => cb({}));
}

function enviarJson(res, obj, status) {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(cuerpo),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(cuerpo);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const ruta = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Saludo para el navegador
  if (ruta === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor de Millonario IA en línea - conectado correctamente');
    return;
  }

  if (ruta === '/api/buscar' && req.method === 'POST') {
    leerCuerpo(req, (body) => {
      const resul = buscar(String(body.nombre || 'Jugador'));
      enviarJson(res, resul);
    });
    return;
  }

  if (ruta === '/api/estado' && req.method === 'GET') {
    const id = parsed.searchParams.get('jugador');
    const j = id && jugadores[id];
    if (!j) { enviarJson(res, { tipo: 'esperando' }); return; }
    tocar(j);

    let mensaje;
    if (j.cola && j.cola.length > 0) {
      mensaje = j.cola.shift();
    } else if (j.partida && partidas[j.partida]) {
      mensaje = { tipo: 'nada' }; // en partida pero sin eventos nuevos
    } else {
      mensaje = { tipo: 'esperando' };
    }
    enviarJson(res, mensaje);
    return;
  }

  if (ruta === '/api/respuesta' && req.method === 'POST') {
    leerCuerpo(req, (body) => {
      const j = body.jugador && jugadores[String(body.jugador)];
      const partida = j && partidas[j.partida];
      if (partida && partida.indice >= 0) {
        const jugador = partida.jugadores.find(x => x.jugador.id === j.id);
        if (jugador && partida.turno && jugador.eleccion === null) {
          tocar(j);
          jugador.eleccion = Number(body.eleccion);
          // Si ambos respondieron, resolver sin esperar el tiempo
          const todos = partida.jugadores.every(x => x.eleccion !== null);
          if (todos) resolver(partida.id, false);
        }
      }
      enviarJson(res, {});
    });
    return;
  }

  if (ruta === '/api/comodin' && req.method === 'POST') {
    leerCuerpo(req, (body) => {
      const j = body.jugador && jugadores[String(body.jugador)];
      if (!j) { enviarJson(res, { error: 'Jugador no encontrado' }); return; }
      tocar(j);
      enviarJson(res, usarComodin(j, String(body.comodin || '')));
    });
    return;
  }

  enviarJson(res, { error: 'Ruta no encontrada' }, 404);
});

// ==================== Arranque ====================
server.listen(HTTP_PORT, () => {
  console.log('Servidor Millonario IA online en http://0.0.0.0:' + HTTP_PORT);
});