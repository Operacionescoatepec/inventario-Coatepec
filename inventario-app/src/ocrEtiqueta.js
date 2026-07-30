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
    // cacheMethod: "none" — tesseract.js normalmente guarda el modelo de
    // idioma en IndexedDB para no re-descargarlo. Hay un bug conocido y
    // documentado (naptha/tesseract.js#901, #414) donde ese guardado se
    // queda colgado SIN error en ciertos navegadores (Safari/iOS entre
    // ellos) — exactamente el síntoma de "se queda en Leyendo etiqueta
    // para siempre". Desactivar el caché evita el bloqueo. Costo: se
    // vuelve a descargar el modelo de idioma (~2-4MB) en cada sesión en
    // vez de una sola vez — aceptable a cambio de que funcione siempre.
    workerPromise = createWorker("eng", 1, { cacheMethod: "none" });
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
// código de barras — esto YA es 100% confiable (no necesita OCR). Aplica
// solo al formato de 12 dígitos (etiquetas tipo "agrupador").
// ---------------------------------------------------------------------------
export function derivarDeCodigoBarras(codigoRaw) {
  const limpio = (codigoRaw || "").replace(/\D/g, "");
  if (limpio.length !== 12) return null;
  return { ordenProduccion: limpio.slice(0, 8), codigoRobot: limpio.slice(8, 12) };
}

// ---------------------------------------------------------------------------
// Etiquetas tipo "tarima" (20 dígitos) parecen codificar SKU y Número de
// Tarima en posiciones fijas — confirmado contra UNA sola etiqueta de
// muestra (SPRITE 600ML, SKU 000353, tarima 9005 → posiciones 6-11 y 16-19).
// Se usa solo como RESPALDO/cruce si el OCR no logra leer esos campos —
// si con más etiquetas reales las posiciones no cuadran, avisa para
// recalibrar esto en vez de confiar ciegamente en él.
// ---------------------------------------------------------------------------
export function derivarDe20Digitos(codigoRaw) {
  const limpio = (codigoRaw || "").replace(/\D/g, "");
  if (limpio.length !== 20) return null;
  return { skuDelBarcode: limpio.slice(6, 12), numeroTarimaDelBarcode: limpio.slice(16, 20) };
}

// ---------------------------------------------------------------------------
// Captura un frame del <video> a un canvas en su resolución NATIVA (no la
// del elemento en pantalla) — clave para que el OCR tenga suficiente detalle.
// ---------------------------------------------------------------------------
export function capturarFrameDeVideo(videoEl) {
  const c = document.createElement("canvas");
  c.width = videoEl.videoWidth;
  c.height = videoEl.videoHeight;
  if (c.width === 0 || c.height === 0) {
    throw new Error("El video de la cámara aún no tenía un frame listo (videoWidth/Height = 0)");
  }
  c.getContext("2d").drawImage(videoEl, 0, 0, c.width, c.height);
  return c;
}

// Patrón repetido en varias etiquetas: "ETIQUETA: valor" en la misma línea
// (CENTRO: MDBI / LINEA: LINEA002 / NO. DE TARIMA: 9005). Recorta la región
// a la derecha del ancla y la relee con un alfabeto restringido.
async function leerValorALaDerechaDe(worker, canvasOriginal, anclaBbox, anchoImagen, opciones) {
  const alto = anclaBbox.y1 - anclaBbox.y0;
  const r = await releerRegion(worker, canvasOriginal, {
    x0: anclaBbox.x1,
    x1: Math.min(anchoImagen, anclaBbox.x1 + alto * (opciones.anchoMultiplicador ?? 8)),
    y0: anclaBbox.y0 - alto * 0.3,
    y1: anclaBbox.y1 + alto * 0.3,
  }, { whitelist: opciones.whitelist });
  return r;
}

// ---------------------------------------------------------------------------
// Extracción completa: 1 pasada general + recortes dirigidos por campo.
// Devuelve { campo: { valor, confianza (0-100), fuente: "ocr" } }
//
// Diseñado para reconocer AL MENOS 2 layouts de etiqueta distintos que ya
// vimos en planta:
//   A) "agrupador": SKU como número grande y aislado bajo "PRODUCTO",
//      fecha+hora en la misma línea, "CENTRO" suelto sin etiqueta.
//   B) "tarima": SKU chico en la línea justo debajo de "Producto:",
//      fecha y hora en líneas separadas, "CENTRO:"/"LINEA:"/"NO. DE
//      TARIMA:" todos con etiqueta explícita seguida del valor.
// Cada campo intenta varias estrategias y se queda con la primera que
// encuentre algo — si aparece un tercer layout, lo más probable es que
// necesite agregar una estrategia más aquí, no reescribir todo.
// ---------------------------------------------------------------------------
export async function leerEtiquetaCompleta(worker, canvasOriginal) {
  const { data: dataGeneral } = await worker.recognize(canvasOriginal, {}, { blocks: true });
  const palabras = aplanarPalabras(dataGeneral);
  const anchoImagen = canvasOriginal.width;
  const altoImagen = canvasOriginal.height;
  const resultado = {};
  const erroresPorCampo = {};

  // --- SKU: dos estrategias, la que encuentre dígitos primero gana ---
  try {
    const wProducto = buscarPalabra(palabras, "PRODUCTO");
    if (wProducto) {
      const alto = wProducto.bbox.y1 - wProducto.bbox.y0;
      // Estrategia A: número GRANDE debajo (diseño "agrupador")
      const rA = await releerRegion(worker, canvasOriginal, {
        x0: wProducto.bbox.x0 - alto, x1: wProducto.bbox.x1 + alto,
        y0: wProducto.bbox.y1, y1: wProducto.bbox.y1 + alto * 2.4,
      }, { whitelist: "0123456789" });
      let digitos = rA.texto.replace(/\D/g, "");
      let confianza = rA.confianza;
      // Estrategia B: línea chica pegada justo debajo (diseño "tarima") —
      // si A no dio nada útil (vacío o demasiados dígitos = agarró basura)
      if (!digitos || digitos.length > 10) {
        const rB = await releerRegion(worker, canvasOriginal, {
          x0: wProducto.bbox.x0 - alto, x1: wProducto.bbox.x1 + alto * 4,
          y0: wProducto.bbox.y1, y1: wProducto.bbox.y1 + alto * 1.3,
        }, { whitelist: "0123456789" });
        const digitosB = rB.texto.replace(/\D/g, "");
        if (digitosB) { digitos = digitosB; confianza = rB.confianza; }
      }
      if (digitos && digitos.length <= 10) resultado.sku = { valor: digitos, confianza, fuente: "ocr" };
    }
  } catch (err) { erroresPorCampo.sku = String(err?.message || err); }

  // --- Centro: 1) "CENTRO: valor" explícito, 2) token suelto arriba ---
  try {
    const wCentro = buscarPalabra(palabras, "CENTRO");
    if (wCentro) {
      const r = await leerValorALaDerechaDe(worker, canvasOriginal, wCentro.bbox, anchoImagen, {
        whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:", anchoMultiplicador: 6,
      });
      const valor = normaliza(r.texto);
      if (valor) resultado.centro = { valor, confianza: r.confianza, fuente: "ocr" };
    } else {
      const candidato = palabras.find(
        (p) => p.bbox.y1 < altoImagen * 0.12 && /^[A-Z]{3,6}$/.test(normaliza(p.texto))
      );
      if (candidato) resultado.centro = { valor: normaliza(candidato.texto), confianza: candidato.confianza, fuente: "ocr" };
    }
  } catch (err) { erroresPorCampo.centro = String(err?.message || err); }

  // --- Línea de producción: "LINEA : LINEA004" o "LINEA: LINEA002" ---
  // Usamos whitelist SOLO de dígitos para el valor (no letras): el OCR
  // confunde fácilmente 'O'/'D' con '0' en fuentes de etiqueta — es más
  // confiable leer nada más los dígitos y anteponer "LINEA" nosotros
  // mismos, ya que sabemos que el ancla encontrada literalmente dice eso.
  try {
    const wLinea = buscarPalabra(palabras, "LINEA");
    if (wLinea) {
      const r = await leerValorALaDerechaDe(worker, canvasOriginal, wLinea.bbox, anchoImagen, {
        whitelist: "0123456789", anchoMultiplicador: 7,
      });
      const digitos = r.texto.replace(/\D/g, "");
      if (digitos) {
        resultado.linea = { valor: `LINEA${digitos.padStart(3, "0")}`, confianza: r.confianza, fuente: "ocr" };
      }
    }
  } catch (err) { erroresPorCampo.linea = String(err?.message || err); }

  // --- Número de tarima física: "NO. DE TARIMA: 9005" (campo nuevo, solo
  //     existe en el diseño "tarima" — NO confundir con "CAJAS X TARIMA") ---
  try {
    const wTarima = palabras.find((p, i) => {
      if (!normaliza(p.texto).includes("TARIMA")) return false;
      // debe tener "DE" cerca a la izquierda en la misma línea, y NO debe
      // tener "CAJAS" cerca (para no agarrar "CAJAS X TARIMA")
      const cercanas = palabras.filter((q) => Math.abs(q.bbox.y0 - p.bbox.y0) < 10);
      const textoLinea = cercanas.map((q) => normaliza(q.texto)).join(" ");
      return textoLinea.includes("DE") && !textoLinea.includes("CAJAS");
    });
    if (wTarima) {
      const r = await leerValorALaDerechaDe(worker, canvasOriginal, wTarima.bbox, anchoImagen, {
        whitelist: "0123456789", anchoMultiplicador: 5,
      });
      const digitos = r.texto.replace(/\D/g, "");
      if (digitos) resultado.numeroTarima = { valor: digitos, confianza: r.confianza, fuente: "ocr" };
    }
  } catch (err) { erroresPorCampo.numeroTarima = String(err?.message || err); }

  // --- Cajas por tarima: número inmediatamente antes de "CAJAS" ---
  try {
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
  } catch (err) { erroresPorCampo.cajasXTarima = String(err?.message || err); }

  // --- Orden de producción (referencia cruzada — el barcode manda si aplica) ---
  try {
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
  } catch (err) { erroresPorCampo.ordenOCR = String(err?.message || err); }

  // --- Fecha y hora de producción ---
  // Primero: si la 1a pasada ya encontró un token LIMPIO con el patrón
  // exacto (ej. "02:57:37" o "08/08/2026" como una sola palabra), usarlo
  // directo — recortar y volver a leer a veces empeora un texto que ya
  // salió bien, porque el reescalado introduce ruido en fuentes chicas.
  try {
    const horaDirecta = palabras.find((p) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(p.texto.trim()));
    if (horaDirecta) resultado.hora = { valor: horaDirecta.texto.trim(), confianza: horaDirecta.confianza, fuente: "ocr" };
  } catch (err) { erroresPorCampo.hora = String(err?.message || err); }
  try {
    const fechaDirecta = palabras.find((p) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(p.texto.trim()));
    if (fechaDirecta) resultado.fecha = { valor: fechaDirecta.texto.trim(), confianza: fechaDirecta.confianza, fuente: "ocr" };
  } catch (err) { erroresPorCampo.fecha = String(err?.message || err); }

  // Respaldo (solo si no se encontraron ya arriba): recorte dirigido a
  // partir del ancla "FECHA" — o de "PRODUCCION" si la "F" se leyó mal,
  // que a veces trae fecha y hora juntas en una sola línea.
  if (!resultado.fecha || !resultado.hora) {
  try {
    let wFecha = buscarPalabra(palabras, "FECHA");
    if (!wFecha) {
      const candidatos = palabras.filter((p) => normaliza(p.texto).includes("PRODUCCION"));
      wFecha = candidatos.find((p) => {
        const mismaLinea = palabras.filter((q) => Math.abs(q.bbox.y0 - p.bbox.y0) < 10);
        return !mismaLinea.some((q) => normaliza(q.texto).includes("ORDEN"));
      });
    }
    if (wFecha) {
      const wDe = palabras.find(
        (p) => normaliza(p.texto) === "DE" && p.bbox.y0 >= wFecha.bbox.y0 - 5 && p.bbox.y0 <= wFecha.bbox.y1 + 5
      ) || wFecha;
      const alto = wFecha.bbox.y1 - wFecha.bbox.y0;
      const r = await releerRegion(worker, canvasOriginal, {
        x0: wDe.bbox.x1 + alto * 4, x1: anchoImagen,
        y0: wFecha.bbox.y0 - alto * 0.3, y1: wFecha.bbox.y1 + alto * 0.3,
      }, { whitelist: "0123456789/:" });
      if (!resultado.fecha) {
        const mFecha = r.texto.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
        if (mFecha) resultado.fecha = { valor: mFecha[0], confianza: r.confianza, fuente: "ocr" };
      }
      if (!resultado.hora) {
        const mHora = r.texto.match(/\d{1,2}:\d{2}(:\d{2})?/);
        if (mHora) resultado.hora = { valor: mHora[0], confianza: r.confianza, fuente: "ocr" };
      }
    }
  } catch (err) { erroresPorCampo.fecha = String(err?.message || err); }
  }

  // Último respaldo para hora sola: ancla "HORA" dedicada (diseños con
  // fecha y hora en líneas separadas)
  if (!resultado.hora) {
    try {
      const wHora = buscarPalabra(palabras, "HORA");
      if (wHora) {
        const r = await leerValorALaDerechaDe(worker, canvasOriginal, wHora.bbox, anchoImagen, {
          whitelist: "0123456789:", anchoMultiplicador: 12,
        });
        const m = r.texto.match(/\d{1,2}:\d{2}(:\d{2})?/);
        if (m) resultado.hora = { valor: m[0], confianza: r.confianza, fuente: "ocr" };
      }
    } catch (err) { erroresPorCampo.hora = String(err?.message || err); }
  }

  // Info de diagnóstico — no se usa para llenar campos, solo para poder ver
  // en la app (y mandarme captura) qué está leyendo realmente la cámara,
  // sin necesidad de consola de desarrollador.
  resultado._diagnostico = {
    version: "ocr-v5-multi-layout-pase1-directo",
    textoCrudo: dataGeneral.text || "(vacío)",
    numPalabrasDetectadas: palabras.length,
    tamanoImagen: `${anchoImagen}x${altoImagen}`,
    errores: erroresPorCampo,
  };

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
  const del12 = derivarDeCodigoBarras(codigoBarras);
  const del20 = derivarDe20Digitos(codigoBarras);
  const sku = campos.sku?.valor || del20?.skuDelBarcode || null;
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
    ordenProduccion: del12?.ordenProduccion || campos.ordenOCR?.valor || null,
    codigoRobot: del12?.codigoRobot || null,
    numeroTarima: campos.numeroTarima?.valor || del20?.numeroTarimaDelBarcode || null,
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
      numeroTarima: campos.numeroTarima?.confianza ?? 0,
    },
  };
}
