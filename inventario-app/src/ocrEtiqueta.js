// =============================================================================
// OCR DE ETIQUETA — combina lectura de código de barras (ya 100% confiable)
// con OCR dirigido por campo para los datos que NO están codificados en el
// barcode (SKU, línea, fecha/hora de producción, cajas por tarima, centro).
//
// DISEÑO — por qué "OCR dirigido por campo" y no "un OCR grande de toda la
// etiqueta":
//   Probamos ambos contra fotos reales de etiqueta. Un solo OCR de la foto
//   completa lee bien el texto pequeño (líneas de ORDEN/FECHA/CAJAS), pero
//   casi siempre FALLA en leer números grandes y aislados como el SKU bajo
//   "PRODUCTO" (la fuente es demasiado distinta al resto y Tesseract la
//   ignora). La solución que sí funciona de forma consistente es:
//     1) una primera pasada rápida sobre toda la etiqueta para UBICAR las
//        palabras "ancla" (PRODUCTO, LINEA, FECHA, CAJAS, etc.) y su
//        posición exacta en la imagen,
//     2) para los campos que lo necesitan, recortar solo esa región,
//        agrandarla 3x y volver a leerla con un alfabeto restringido
//        (solo dígitos, por ejemplo) — esto sube la confianza de ~0-20%
//        a 85-95% en nuestras pruebas.
//
// El código de barras (Orden + Robot) siempre tiene prioridad sobre el OCR
// para esos 2 campos, porque es 100% determinístico; el OCR de esos mismos
// campos solo se usa como referencia cruzada / respaldo.
// =============================================================================

import { createWorker } from "tesseract.js";

// ---------------------------------------------------------------------------
// Worker de Tesseract — se crea UNA sola vez (es lento: descarga ~2-4MB la
// primera vez) y se reutiliza en todos los escaneos de la sesión.
// ---------------------------------------------------------------------------
let workerPromise = null;
export function obtenerWorkerOCR() {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
  }
  return workerPromise;
}

export async function liberarWorkerOCR() {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------
function normaliza(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function aplanarPalabras(data) {
  const palabras = [];
  (data.blocks || []).forEach((b) =>
    (b.paragraphs || []).forEach((p) =>
      (p.lines || []).forEach((l) =>
        (l.words || []).forEach((w) =>
          palabras.push({ texto: w.text, confianza: w.confidence, bbox: w.bbox })
        )
      )
    )
  );
  return palabras;
}

function buscarPalabra(palabras, patron) {
  return palabras.find((p) => normaliza(p.texto).includes(patron));
}

// Recorta una región del frame original, la escala 3x, y la vuelve a leer
// con un alfabeto restringido (whitelist) y modo "línea única" (psm 7) —
// mucho más preciso que leer la etiqueta completa de un tirón.
async function releerRegion(worker, canvasOriginal, region, { whitelist = "", psm = "7" } = {}) {
  const x0 = Math.max(0, Math.round(region.x0));
  const y0 = Math.max(0, Math.round(region.y0));
  const x1 = Math.min(canvasOriginal.width, Math.round(region.x1));
  const y1 = Math.min(canvasOriginal.height, Math.round(region.y1));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  const escala = 3;
  const c = document.createElement("canvas");
  c.width = w * escala;
  c.height = h * escala;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvasOriginal, x0, y0, w, h, 0, 0, c.width, c.height);

  await worker.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(c);
  await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
  return { texto: (data.text || "").trim(), confianza: data.confidence ?? 0 };
}

// ---------------------------------------------------------------------------
// Deriva Orden de Producción (8 dígitos) + Código de Robot (4 dígitos) del
// código de barras — esto YA es 100% confiable (no necesita OCR).
// ---------------------------------------------------------------------------
export function derivarDeCodigoBarras(codigoRaw) {
  const limpio = (codigoRaw || "").replace(/\D/g, "");
  if (limpio.length !== 12) return null;
  return { ordenProduccion: limpio.slice(0, 8), codigoRobot: limpio.slice(8, 12) };
}

// ---------------------------------------------------------------------------
// Captura un frame del <video> a un canvas en su resolución NATIVA (no la
// del elemento en pantalla) — clave para que el OCR tenga suficiente detalle.
// ---------------------------------------------------------------------------
export function capturarFrameDeVideo(videoEl) {
  const c = document.createElement("canvas");
  c.width = videoEl.videoWidth;
  c.height = videoEl.videoHeight;
  c.getContext("2d").drawImage(videoEl, 0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------------------
// Extracción completa: 1 pasada general + recortes dirigidos por campo.
// Devuelve { campo: { valor, confianza (0-100), fuente: "ocr" } }
//
// NOTA para cuando se pruebe con más fotos reales: los multiplicadores de
// recorte (alto*2.4, alto*7, etc.) se calibraron contra una etiqueta de
// muestra. Si con otras fotos/ángulos algún campo sale corto o con ruido de
// la columna vecina, ajusta esos multiplicadores — no la lógica en sí.
// ---------------------------------------------------------------------------
export async function leerEtiquetaCompleta(worker, canvasOriginal) {
  const { data: dataGeneral } = await worker.recognize(canvasOriginal, {}, { blocks: true });
  const palabras = aplanarPalabras(dataGeneral);
  const anchoImagen = canvasOriginal.width;
  const altoImagen = canvasOriginal.height;
  const resultado = {};

  // --- SKU: número grande justo debajo de la palabra "PRODUCTO" ---
  const wProducto = buscarPalabra(palabras, "PRODUCTO");
  if (wProducto) {
    const alto = wProducto.bbox.y1 - wProducto.bbox.y0;
    const r = await releerRegion(worker, canvasOriginal, {
      x0: wProducto.bbox.x0 - alto,
      x1: wProducto.bbox.x1 + alto,
      y0: wProducto.bbox.y1,
      y1: wProducto.bbox.y1 + alto * 2.4,
    }, { whitelist: "0123456789" });
    const digitos = r.texto.replace(/\D/g, "");
    if (digitos) resultado.sku = { valor: digitos, confianza: r.confianza, fuente: "ocr" };
  }

  // --- Centro: token corto en mayúsculas en la esquina superior de la etiqueta ---
  const candidatoCentro = palabras.find(
    (p) => p.bbox.y1 < altoImagen * 0.12 && /^[A-Z]{3,6}$/.test(normaliza(p.texto))
  );
  if (candidatoCentro) {
    resultado.centro = { valor: normaliza(candidatoCentro.texto), confianza: candidatoCentro.confianza, fuente: "ocr" };
  }

  // --- Línea de producción ---
  const wLinea = buscarPalabra(palabras, "LINEA");
  if (wLinea) {
    const alto = wLinea.bbox.y1 - wLinea.bbox.y0;
    const r = await releerRegion(worker, canvasOriginal, {
      x0: wLinea.bbox.x1,
      x1: wLinea.bbox.x1 + alto * 7,
      y0: wLinea.bbox.y0 - alto * 0.3,
      y1: wLinea.bbox.y1 + alto * 0.3,
    }, { whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:" });
    const m = r.texto.match(/([A-Z]+)[:\s]*([0-9O]{2,4})/i);
    if (m) {
      resultado.linea = {
        valor: `${m[1].toUpperCase()}${m[2].toUpperCase().replace(/O/g, "0")}`,
        confianza: r.confianza, fuente: "ocr",
      };
    }
  }

  // --- Cajas por tarima: número inmediatamente antes de la palabra "CAJAS" ---
  const wCajas = buscarPalabra(palabras, "CAJAS");
  if (wCajas) {
    const idx = palabras.indexOf(wCajas);
    const anterior = palabras[idx - 1];
    if (anterior && /^\d+$/.test(anterior.texto.replace(/\D/g, "")) && anterior.texto.replace(/\D/g, "")) {
      resultado.cajasXTarima = {
        valor: parseInt(anterior.texto.replace(/\D/g, ""), 10),
        confianza: anterior.confianza, fuente: "ocr",
      };
    }
  }

  // --- Orden de producción (referencia cruzada — el barcode manda) ---
  const wOrden = buscarPalabra(palabras, "ORDEN");
  if (wOrden) {
    const candidato = palabras.find(
      (p) => /^\d{6,9}$/.test(p.texto.replace(/\D/g, "")) &&
        p.bbox.y0 >= wOrden.bbox.y0 - 5 && p.bbox.y0 <= wOrden.bbox.y1 + 15
    );
    if (candidato) {
      resultado.ordenOCR = { valor: candidato.texto.replace(/\D/g, ""), confianza: candidato.confianza, fuente: "ocr" };
    }
  }

  // --- Fecha y hora de producción ---
  const wFecha = buscarPalabra(palabras, "FECHA");
  if (wFecha) {
    const wDe = palabras.find(
      (p) => normaliza(p.texto) === "DE" && p.bbox.y0 >= wFecha.bbox.y0 - 5 && p.bbox.y0 <= wFecha.bbox.y1 + 5
    ) || wFecha;
    const alto = wFecha.bbox.y1 - wFecha.bbox.y0;
    const r = await releerRegion(worker, canvasOriginal, {
      x0: wDe.bbox.x1 + alto * 4,
      x1: anchoImagen,
      y0: wFecha.bbox.y0 - alto * 0.3,
      y1: wFecha.bbox.y1 + alto * 0.3,
    }, { whitelist: "0123456789/:" });
    const m = r.texto.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\D*(\d{1,2}:\d{2}(:\d{2})?)/);
    if (m) {
      resultado.fecha = { valor: m[1], confianza: r.confianza, fuente: "ocr" };
      resultado.hora = { valor: m[2], confianza: r.confianza, fuente: "ocr" };
    }
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Combina barcode + OCR + catálogo ya cargado en un solo objeto "pendiente",
// listo para alimentar el flujo existente (setPendiente → ModalCantidadPT).
// `catalogoPT` es el catálogo ya cargado desde Supabase (mismo que usa el
// resto de la app), para no inventar la descripción del producto por OCR
// cuando ya la tenemos de la base de datos.
// ---------------------------------------------------------------------------
export function construirPendienteDesdeEscaneoInteligente({ codigoBarras, campos, catalogoPT }) {
  const delBarcode = derivarDeCodigoBarras(codigoBarras);
  const sku = campos.sku?.valor || null;
  const infoCatalogo = sku ? catalogoPT?.[sku] : null;

  let fechaProduccionISO = null;
  if (campos.fecha?.valor) {
    const [d, m, a] = campos.fecha.valor.split("/");
    const anio = a.length === 2 ? `20${a}` : a;
    const horaStr = campos.hora?.valor || "00:00:00";
    fechaProduccionISO = `${anio}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${horaStr}`;
  }

  let agrupadorCaducidad = null;
  if (fechaProduccionISO && infoCatalogo?.diasVida) {
    const f = new Date(fechaProduccionISO);
    f.setDate(f.getDate() + infoCatalogo.diasVida);
    agrupadorCaducidad = f.toISOString().slice(0, 10);
  }

  return {
    barcode: (codigoBarras || "").replace(/\D/g, ""),
    ordenProduccion: delBarcode?.ordenProduccion || campos.ordenOCR?.valor || null,
    codigoRobot: delBarcode?.codigoRobot || null,
    productoId: sku || "?",
    linea: campos.linea?.valor || "DESCONOCIDA",
    centro: campos.centro?.valor || null,
    fechaProduccion: fechaProduccionISO,
    cajasXPalet: campos.cajasXTarima?.valor ?? infoCatalogo?.cajasXTarima ?? null,
    diasVida: infoCatalogo?.diasVida ?? null,
    agrupadorCaducidad,
    // se guardan las confianzas para poder mostrar advertencias en la UI
    // de revisión (campo en ámbar si confianza < 70%)
    _confianzas: {
      sku: campos.sku?.confianza ?? 0,
      linea: campos.linea?.confianza ?? 0,
      fecha: campos.fecha?.confianza ?? 0,
      cajasXTarima: campos.cajasXTarima?.confianza ?? 0,
      centro: campos.centro?.confianza ?? 0,
    },
  };
}
