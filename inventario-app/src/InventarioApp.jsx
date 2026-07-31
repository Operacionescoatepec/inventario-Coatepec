import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  Scan, Package, CheckCircle2, AlertTriangle, XCircle, ClipboardList, Upload,
  Trash2, ChevronRight, ChevronLeft, Camera, PenLine, MapPin, Calendar, Boxes,
  Layers, X, GlassWater, Container, ShoppingBag, Box, UserCircle2, LogOut,
  CloudUpload, Search, Flashlight,
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";
import fondoInicio from "./assets/fondo-inicio.png";
import {
  BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat,
} from "@zxing/library";
// NOTA: "./ocrEtiqueta" (y tesseract.js, que pesa varios cientos de KB) se
// importa de forma DINÁMICA dentro de EscaneoInteligente, no aquí arriba.
// Así, el motor de OCR solo se descarga la primera vez que alguien abre el
// modo "Inteligente" — quien solo usa "Con etiqueta"/"Sin etiqueta" (el caso
// más común en piso) nunca paga ese costo de carga.

// ===========================================================================
// CONEXIÓN A SUPABASE
//
// Las credenciales viven en variables de entorno (.env), no en el código,
// para poder cambiarlas sin tocar el repo y para no exponerlas en git.
// En Vercel se configuran en Project Settings → Environment Variables con
// los mismos nombres: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.
// ===========================================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Faltan variables de entorno VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. " +
    "Revisa tu archivo .env (desarrollo local) o las Environment Variables del proyecto en Vercel."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Crea una fila y devuelve el registro insertado (equivalente a .select().single())
async function insertarYDevolver(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw error;
  return data;
}

// ===========================================================================
// IDENTIDAD DE PLANTA
// ===========================================================================
const PLANTA = "Planta Coatepec";

// Paleta de marca: rojo Coca-Cola sobre fondo oscuro de bodega (alto contraste,
// legible bajo luz de nave industrial). El logo real iría aquí como <img>
// si la planta tiene licencia de uso interno — se deja el espacio marcado.
const ROJO = "#E2231A";
const ROJO_OSCURO = "#A3170F";
const CREMA = "#F7F3EC";

// ===========================================================================
// USUARIOS — búsqueda en tiempo real contra la tabla `usuarios` de Supabase
// ===========================================================================
async function buscarUsuarioPorNumero(numeroEmpleado) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("nombre")
    .eq("numero_empleado", numeroEmpleado.trim())
    .eq("activo", true)
    .maybeSingle();
  if (error) {
    console.error("Error buscando usuario:", error);
    return { ok: false, error: "No se pudo conectar con el directorio." };
  }
  if (!data) return { ok: false, error: "no_encontrado" };
  return { ok: true, nombre: data.nombre };
}

// ===========================================================================
// CATÁLOGO DE SKUs — PRODUCTO TERMINADO
// (base de datos actualizable: SKU → descripción, cajas por tarima, stock SAP)
// ===========================================================================
// ===========================================================================
// CATÁLOGO — se carga UNA VEZ desde Supabase (tabla catalogo_productos) y se
// transforma a la misma forma que el resto del código ya espera, para no
// tener que tocar la lógica de implícitos/factores que ya funciona.
// ===========================================================================
const FAMILIAS_RETORNABLES = [
  { id: "ref_pet", nombre: "Ref PET", icon: Container },
  { id: "vidrio", nombre: "Vidrio", icon: GlassWater },
  { id: "garrafon", nombre: "Garrafón", icon: ShoppingBag },
  { id: "tarimas", nombre: "Tarimas", icon: Layers },
  { id: "embalaje", nombre: "Embalaje", icon: Box },
];

// Filas del catálogo que aún no tienen familia asignada en Supabase (los 294
// SKUs nuevos migrados) se agrupan aquí para no perderlas de la app.
const FAMILIA_SIN_ASIGNAR = "sin_asignar";

function filaSupabaseAEntradaCatalogo(row) {
  return {
    sku: row.sku,
    nombre: row.nombre,
    factores: row.factores && row.factores.length ? row.factores : undefined,
    factorDefault: row.factor_default ?? undefined,
    granel: row.es_granel || false,
    esPieza: row.es_pieza || false,
    requiereEstado: row.requiere_estado && row.requiere_estado.length ? row.requiere_estado : undefined,
    implicito: row.implicito_sku ? { sku: row.implicito_sku, nombre: row.implicito_nombre } : undefined,
    implicitos: row.implicitos_multiples || undefined,
    cajasXTarima: row.cajas_x_tarima ?? undefined,
    diasVida: row.dias_vida ?? undefined,
    stockSap: row.stock_sap ?? 0,
    orden: row.orden ?? 0,
    precioUnitario: row.precio_unitario ?? null,
  };
}

async function cargarCatalogoDesdeSupabase() {
  const { data, error } = await supabase
    .from("catalogo_productos")
    .select("*")
    .eq("activo", true)
    .order("orden", { ascending: true });

  if (error) {
    console.error("Error cargando catálogo:", error);
    return { ok: false, error: error.message };
  }

  const catalogoPT = {};
  const catalogoRetornables = {
    ref_pet: {}, vidrio: {}, garrafon: {}, tarimas: {}, embalaje: {}, [FAMILIA_SIN_ASIGNAR]: {},
  };

  for (const row of data) {
    const entrada = filaSupabaseAEntradaCatalogo(row);
    if (row.modulo === "producto_terminado") {
      catalogoPT[row.sku] = entrada;
    } else {
      const familia = row.familia || FAMILIA_SIN_ASIGNAR;
      if (!catalogoRetornables[familia]) catalogoRetornables[familia] = {};
      catalogoRetornables[familia][row.clave_catalogo] = entrada;
    }
  }

  return { ok: true, catalogoPT, catalogoRetornables };
}

const UBICACIONES_DEMO = [
  "Línea 2", "Línea 3", "Línea 4", "Línea 5",
  "Racks Push Back", "Nave 1", "Nave 2", "Nave 3", "Nave 3 A", "Nave 3 B", "Nave 3 C",
  "Otros",
];

// Etiquetas "reales" decodificadas de fotos de planta — simulan el escaneo de cámara
const ETIQUETAS_DEMO = [
  { barcode: "126823630125", ordenProduccion: "12682363", codigoRobot: "0125", productoId: "1808", agrupadorCaducidad: "2026-08-19", linea: "LINEA004", fechaProduccion: "2026-06-10T11:54:25", cajasXPalet: 40, diasVida: 70 },
  { barcode: "126758120001", ordenProduccion: "12675812", codigoRobot: "0001", productoId: "97762", agrupadorCaducidad: "2026-11-30", linea: "LINEA003", fechaProduccion: "2026-06-03T22:33:56", cajasXPalet: 96, diasVida: 180 },
  { barcode: "126808020176", ordenProduccion: "12680802", codigoRobot: "0176", productoId: "360", agrupadorCaducidad: "2026-08-26", linea: "LINEA003", fechaProduccion: "2026-06-12T13:28:54", cajasXPalet: 54, diasVida: 75 },
  { barcode: "126807540185", ordenProduccion: "12680754", codigoRobot: "0185", productoId: "100575", agrupadorCaducidad: "2026-08-23", linea: "LINEA004", fechaProduccion: "2026-06-09T02:23:00", cajasXPalet: 80, diasVida: 75 },
  { barcode: "123888150076", ordenProduccion: "12388815", codigoRobot: "0076", productoId: "98390", agrupadorCaducidad: "2025-03-29", linea: "LINEA001", fechaProduccion: "2024-12-29T08:12:39", cajasXPalet: 64, diasVida: 90 },
];

// ===========================================================================
// PARSER DE BARCODE — Orden de Producción (8 dígitos) + Código Robot (4 dígitos)
// ===========================================================================
// Nunca bloquea el escaneo, solo interpreta lo que puede. Antes, cualquier
// código que no tuviera EXACTAMENTE 12 dígitos se rechazaba por completo
// (incluyendo los de 20 dígitos de las etiquetas "tarima", y cualquier QR)
// — eso hacía inservible "Con etiqueta" para varios formatos reales de
// planta. Ahora reconoce los formatos conocidos y, si no reconoce ninguno,
// deja pasar igual el código crudo (se completa el resto a mano).
function parseBarcode(raw) {
  const clean = (raw || "").replace(/\D/g, "");
  if (!clean) {
    return { ok: false, error: "No se detectaron dígitos en el código escaneado." };
  }
  if (clean.length === 12) {
    return {
      ok: true, formatoBarcode: "agrupador-12",
      ordenProduccion: clean.slice(0, 8), codigoRobot: clean.slice(8, 12),
      detalleTecnico: `Código de 12 dígitos → formato "agrupador": Orden ${clean.slice(0, 8)} + Robot ${clean.slice(8, 12)}.`,
    };
  }
  if (clean.length === 20) {
    // Posiciones confirmadas contra una etiqueta real de muestra (SKU
    // 000353 / tarima 9005). Si con más etiquetas esto no cuadra, avisa
    // para recalibrar las posiciones en vez de asumir que siempre aplican.
    return {
      ok: true, formatoBarcode: "tarima-20",
      productoId: clean.slice(6, 12), numeroTarima: clean.slice(16, 20),
      detalleTecnico: `Código de 20 dígitos → formato "tarima": SKU ${clean.slice(6, 12)} (posiciones 6-11), Núm. Tarima ${clean.slice(16, 20)} (posiciones 16-19).`,
    };
  }
  return {
    ok: true, formatoBarcode: "desconocido",
    detalleTecnico: `Código de ${clean.length} dígitos — no coincide con los formatos conocidos (12 o 20). Se guardó el código tal cual; completa SKU y fecha a mano.`,
  };
}

function formatFecha(iso) {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

function diasParaCaducar(iso) {
  const hoy = new Date("2026-06-20");
  const fin = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return Math.round((fin - hoy) / (1000 * 60 * 60 * 24));
}

function hoyISO() {
  return new Date("2026-06-20").toISOString().slice(0, 10);
}

function aCajasEquivalentes(cantidad, unidad, cajasXTarima) {
  if (unidad === "cajas") return cantidad;
  const factor = cajasXTarima && cajasXTarima > 0 ? cajasXTarima : 50;
  return cantidad * factor;
}

// ===========================================================================
// EXPORTAR REPORTE — botón protegido por PIN compartido (no hay login
// individual en esta app, así que un PIN de supervisor es el control de
// acceso más simple y coherente con el resto del diseño). Al validarse,
// consulta las 2 vistas de Supabase y descarga los 2 CSV que necesita
// generar_inventario_final.py.
// ===========================================================================
const PIN_EXPORTAR = "3133"; // <- cambia este PIN aquí cuando quieras

function csvDesdeFilas(filas) {
  if (!filas || filas.length === 0) return "";
  const columnas = Object.keys(filas[0]);
  const escapar = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lineas = [columnas.join(",")];
  for (const fila of filas) lineas.push(columnas.map((c) => escapar(fila[c])).join(","));
  return lineas.join("\n");
}

function descargarArchivo(nombre, contenido) {
  const blob = new Blob(["\uFEFF" + contenido], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ModalExportar({ onCerrar }) {
  const [pin, setPin] = useState("");
  const [fase, setFase] = useState("pin"); // pin | exportando | listo
  const [errorMsg, setErrorMsg] = useState("");

  const validarYExportar = async () => {
    if (pin !== PIN_EXPORTAR) {
      setErrorMsg("PIN incorrecto");
      return;
    }
    setErrorMsg("");
    setFase("exportando");
    try {
      const [{ data: catalogo, error: e1 }, { data: escaneado, error: e2 }] = await Promise.all([
        supabase.from("vista_catalogo_export").select("*"),
        supabase.from("vista_escaneado_export").select("*"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const fecha = new Date().toISOString().slice(0, 10);
      descargarArchivo(`catalogo_${fecha}.csv`, csvDesdeFilas(catalogo));
      descargarArchivo(`escaneado_${fecha}.csv`, csvDesdeFilas(escaneado));
      setFase("listo");
    } catch (err) {
      console.error("Error exportando:", err);
      setErrorMsg("No se pudo exportar: " + (err.message || String(err)));
      setFase("pin");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-[#161D14] border border-[#2A332C] rounded-2xl w-full max-w-xs p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-[#EDEAE2] font-bold">Exportar reporte</div>
          <button onClick={onCerrar} className="text-[#6E776A] hover:text-[#EDEAE2]"><X size={20} /></button>
        </div>

        {fase === "pin" && (
          <>
            <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">PIN de supervisor</label>
            <input
              type="password" inputMode="numeric" value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && validarYExportar()}
              style={{ color: "#EDEAE2" }}
              className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-3 text-lg text-center tracking-[0.4em] focus:outline-none focus:border-[#E2231A]"
              autoFocus
            />
            {errorMsg && <div className="text-[11px] text-[#E8A8A8]">{errorMsg}</div>}
            <button onClick={validarYExportar} className="w-full bg-[#E2231A] text-white font-bold py-3 rounded-xl">
              Exportar catálogo + escaneado
            </button>
          </>
        )}

        {fase === "exportando" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-7 h-7 border-3 rounded-full animate-spin" style={{ borderColor: "#2A332C", borderTopColor: "#E2231A" }} />
            <div className="text-sm" style={{ color: "#8A9389" }}>Exportando desde Supabase…</div>
          </div>
        )}

        {fase === "listo" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 size={32} className="text-[#9FD3A6]" />
            <div className="text-sm text-center" style={{ color: "#EDEAE2" }}>
              Listo — se descargaron 2 archivos (catálogo y escaneado) a tu carpeta de descargas.
            </div>
            <button onClick={onCerrar} className="w-full bg-[#1B2119] border border-[#2A332C] text-[#EDEAE2] font-medium py-2.5 rounded-xl">
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// PANTALLA DE BIENVENIDA / SELECCIÓN DE MÓDULO
// ===========================================================================
function PantallaInicio({ onElegirModulo, onExportar }) {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: ROJO }}
    >
      <div
        className="w-full bg-cover bg-top bg-no-repeat"
        style={{ backgroundImage: `url(${fondoInicio})`, aspectRatio: "628 / 771" }}
        role="img"
        aria-label={`Inventario Digital — ${PLANTA}`}
      />

      <div className="flex-1 bg-[#0E1410] rounded-t-[28px] px-5 pt-7 pb-10 space-y-3">
        <div className="text-[#8A9389] text-xs tracking-wide text-center mb-2">¿QUÉ VAS A INVENTARIAR?</div>

        <button
          onClick={() => onElegirModulo("producto_terminado")}
          className="w-full bg-[#161D14] border border-[#2A332C] rounded-2xl p-4 flex items-center gap-4 active:scale-[0.98] transition-transform text-left"
        >
          <div className="w-12 h-12 rounded-xl bg-[#E2231A]/15 flex items-center justify-center shrink-0">
            <Package size={24} className="text-[#E2231A]" />
          </div>
          <div className="flex-1">
            <div className="text-[#EDEAE2] font-bold text-base">Producto Terminado</div>
            <div className="text-[#8A9389] text-xs mt-0.5">TPM con fechas, o físico vs. teórico</div>
          </div>
          <ChevronRight size={20} className="text-[#6E776A]" />
        </button>

        <button
          onClick={() => onElegirModulo("retornables")}
          className="w-full bg-[#161D14] border border-[#2A332C] rounded-2xl p-4 flex items-center gap-4 active:scale-[0.98] transition-transform text-left"
        >
          <div className="w-12 h-12 rounded-xl bg-[#E2231A]/15 flex items-center justify-center shrink-0">
            <Layers size={24} className="text-[#E2231A]" />
          </div>
          <div className="flex-1">
            <div className="text-[#EDEAE2] font-bold text-base">Materiales Retornables</div>
            <div className="text-[#8A9389] text-xs mt-0.5">Vidrio, Ref PET, Tarimas, Garrafón, Embalaje</div>
          </div>
          <ChevronRight size={20} className="text-[#6E776A]" />
        </button>

        <button
          onClick={onExportar}
          className="w-full text-center py-3 text-[12px] text-[#6E776A] active:text-[#8A9389]"
        >
          Exportar reporte (supervisores)
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// SUBMODO: TPM vs Sin fechas (solo para Producto Terminado)
// ===========================================================================
function PantallaSubmodoPT({ onElegir, onVolver }) {
  return (
    <div className="min-h-screen bg-[#0E1410] flex flex-col">
      <BarraSuperiorSimple titulo="Producto Terminado" onVolver={onVolver} />
      <div className="flex-1 flex flex-col justify-center px-5 space-y-3 max-w-md mx-auto w-full">
        <div className="text-[#8A9389] text-xs tracking-wide text-center mb-2">¿CON QUÉ MODALIDAD?</div>
        <button
          onClick={() => onElegir("tpm")}
          className="w-full bg-[#161D14] border border-[#2A332C] rounded-2xl p-4 text-left active:scale-[0.98] transition-transform"
        >
          <div className="flex items-center gap-2 mb-1">
            <Calendar size={18} className="text-[#E2231A]" />
            <span className="text-[#EDEAE2] font-bold">TPM (con fechas)</span>
          </div>
          <p className="text-[#8A9389] text-xs leading-relaxed">
            Conteo por lote y fecha de máxima frescura. Un SKU puede tener varios lotes; la suma de todos debe coincidir con el stock total.
          </p>
        </button>
        <button
          onClick={() => onElegir("sin_fechas")}
          className="w-full bg-[#161D14] border border-[#2A332C] rounded-2xl p-4 text-left active:scale-[0.98] transition-transform"
        >
          <div className="flex items-center gap-2 mb-1">
            <ClipboardList size={18} className="text-[#E2231A]" />
            <span className="text-[#EDEAE2] font-bold">Sin fechas (físico vs. teórico)</span>
          </div>
          <p className="text-[#8A9389] text-xs leading-relaxed">
            Conteo simple por SKU, comparado directo contra el stock teórico de SAP. No se desglosa por lote.
          </p>
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// SUBMODO: elegir familia (solo para Retornables)
// ===========================================================================
function PantallaFamilia({ onElegir, onVolver }) {
  return (
    <div className="min-h-screen bg-[#0E1410] flex flex-col">
      <BarraSuperiorSimple titulo="Materiales Retornables" onVolver={onVolver} />
      <div className="px-5 pt-2 max-w-md mx-auto w-full">
        <div className="text-[#8A9389] text-xs tracking-wide text-center mb-3">SELECCIONA LA FAMILIA</div>
        <div className="space-y-2.5">
          {FAMILIAS_RETORNABLES.map((f) => (
            <button
              key={f.id}
              onClick={() => onElegir(f.id)}
              className="w-full bg-[#161D14] border border-[#2A332C] rounded-2xl p-4 flex items-center gap-4 active:scale-[0.98] transition-transform text-left"
            >
              <div className="w-11 h-11 rounded-xl bg-[#E2231A]/15 flex items-center justify-center shrink-0">
                <f.icon size={22} className="text-[#E2231A]" />
              </div>
              <div className="flex-1 text-[#EDEAE2] font-bold">{f.nombre}</div>
              <ChevronRight size={20} className="text-[#6E776A]" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BarraSuperiorSimple({ titulo, onVolver }) {
  return (
    <header
      className="px-4 flex items-center gap-3 border-b border-[#2A332C]"
      style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
    >
      <button onClick={onVolver} className="text-[#8A9389] hover:text-[#EDEAE2]">
        <ChevronLeft size={22} />
      </button>
      <div>
        <div className="text-[10px] text-[#6E776A] tracking-wide">{PLANTA.toUpperCase()}</div>
        <div className="text-[#EDEAE2] font-bold text-sm">{titulo}</div>
      </div>
    </header>
  );
}

// ===========================================================================
// MODAL DE SINCRONIZACIÓN — pide número de empleado, busca nombre en directorio
// ===========================================================================
function ModalSincronizar({ totalRegistros, onCancelar, onConfirmar, sincronizando, error }) {
  const [numEmpleado, setNumEmpleado] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState(null); // null | "no_encontrado" | nombre

  const buscar = async () => {
    const id = numEmpleado.trim();
    if (!id) return;
    setBuscando(true);
    const res = await buscarUsuarioPorNumero(id);
    setResultado(res.ok ? res.nombre : "no_encontrado");
    setBuscando(false);
  };

  const confirmar = () => {
    onConfirmar({ numEmpleado: numEmpleado.trim(), nombre: resultado });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-[#161D14] border border-[#2A332C] rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] text-[#8A9389] tracking-wide">SINCRONIZAR SESIÓN</div>
            <div className="text-base font-bold mt-0.5 text-[#EDEAE2]">{totalRegistros} registros listos</div>
          </div>
          <button onClick={onCancelar} className="text-[#6E776A] hover:text-[#EDEAE2]">
            <X size={20} />
          </button>
        </div>

        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">NÚMERO DE EMPLEADO</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <UserCircle2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6E776A]" />
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={numEmpleado}
                onChange={(e) => { setNumEmpleado(e.target.value); setResultado(null); }}
                placeholder="Ej. 10234"
                className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg pl-9 pr-3 py-3 text-base font-bold placeholder:text-[#4A524A] placeholder:font-normal focus:outline-none focus:border-[#E2231A]"
                autoFocus
              />
            </div>
            <button
              onClick={buscar}
              disabled={!numEmpleado.trim() || buscando}
              className="bg-[#2A332C] px-4 rounded-lg flex items-center justify-center disabled:opacity-40"
            >
              <Search size={18} className="text-[#EDEAE2]" />
            </button>
          </div>
        </div>

        {buscando && (
          <div className="text-[11px] text-[#8A9389] flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-[#8A9389] border-t-transparent rounded-full animate-spin" />
            Buscando en el directorio…
          </div>
        )}

        {resultado && resultado !== "no_encontrado" && (
          <div className="flex items-center gap-2 bg-[#15201A] border border-[#2A332C] rounded-lg p-3">
            <CheckCircle2 size={18} className="text-[#9FD3A6] shrink-0" />
            <div>
              <div className="text-[#9FD3A6] font-bold text-sm">{resultado}</div>
              <div className="text-[10px] text-[#8A9389]">Empleado #{numEmpleado.trim()}</div>
            </div>
          </div>
        )}

        {resultado === "no_encontrado" && (
          <div className="flex items-start gap-2 bg-[#2A1818] border border-[#5A2A2A] rounded-lg p-3 text-sm text-[#E8A8A8]">
            <XCircle size={16} className="mt-0.5 shrink-0" />
            No se encontró ese número de empleado en el directorio. Verifica el número.
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-[#2A1818] border border-[#5A2A2A] rounded-lg p-3 text-sm text-[#E8A8A8]">
            <XCircle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <button
          onClick={confirmar}
          disabled={!resultado || resultado === "no_encontrado" || sincronizando}
          className="w-full bg-[#E2231A] text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-40"
        >
          {sincronizando ? (
            <>
              <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Sincronizando…
            </>
          ) : (
            <>
              <CloudUpload size={18} /> Confirmar y sincronizar
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// SELECTOR DE UBICACIÓN reutilizable (con "Otros" → campo libre)
// ===========================================================================
function SelectorUbicacion({ ubicacion, setUbicacion, ubicacionLibre, setUbicacionLibre }) {
  return (
    <div>
      <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">UBICACIÓN</label>
      <div className="relative">
        <MapPin size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6E776A]" />
        <select
          value={ubicacion}
          onChange={(e) => setUbicacion(e.target.value)}
          style={{ color: "#EDEAE2" }}
          className="w-full bg-[#1B2119] border border-[#2A332C] rounded-lg pl-9 pr-3 py-3 text-sm focus:outline-none focus:border-[#E2231A] appearance-none"
        >
          {UBICACIONES_DEMO.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </div>
      {ubicacion === "Otros" && (
        <input
          value={ubicacionLibre}
          onChange={(e) => setUbicacionLibre(e.target.value)}
          placeholder="Especifica la ubicación"
          className="w-full mt-2 bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-2.5 text-sm placeholder:text-[#4A524A] focus:outline-none focus:border-[#E2231A]"
        />
      )}
    </div>
  );
}

// ===========================================================================
// MODAL — confirmar escaneo de etiqueta de Producto Terminado (modo TPM, con fecha)
// ===========================================================================
// ===========================================================================
// BUSCADOR DE SKU — autocompletado por número o nombre de producto, para
// evitar el error de dedo de escribir el SKU a mano. Se elige de una lista
// ya validada contra el catálogo en vez de tipear dígitos sueltos.
// ===========================================================================
function BuscadorSKU({ catalogoPT, valor, onSeleccionar, autoFocus }) {
  const [texto, setTexto] = useState(valor || "");
  const [abierto, setAbierto] = useState(false);
  const contenedorRef = useRef(null);

  useEffect(() => {
    function onClickFuera(e) {
      if (contenedorRef.current && !contenedorRef.current.contains(e.target)) setAbierto(false);
    }
    document.addEventListener("mousedown", onClickFuera);
    document.addEventListener("touchstart", onClickFuera);
    return () => {
      document.removeEventListener("mousedown", onClickFuera);
      document.removeEventListener("touchstart", onClickFuera);
    };
  }, []);

  const entradas = useMemo(() => Object.values(catalogoPT || {}), [catalogoPT]);
  const resultados = useMemo(() => {
    const q = texto.trim().toLowerCase();
    if (!q) return [];
    return entradas
      .filter((e) => e.sku.toLowerCase().includes(q) || (e.nombre || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [entradas, texto]);

  const seleccionar = (entrada) => {
    setTexto(entrada.sku);
    setAbierto(false);
    onSeleccionar(entrada.sku);
  };

  const cambiarTexto = (valorNuevo) => {
    setTexto(valorNuevo);
    setAbierto(true);
    onSeleccionar(valorNuevo.trim());
  };

  return (
    <div ref={contenedorRef} className="relative">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6E776A]" />
        <input
          type="text"
          inputMode="numeric"
          value={texto}
          onChange={(e) => cambiarTexto(e.target.value)}
          onFocus={() => setAbierto(true)}
          placeholder="SKU o nombre del producto…"
          autoFocus={autoFocus}
          style={{ color: "#EDEAE2" }}
          className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg pl-9 pr-3 py-3 text-base font-bold placeholder:text-[#4A524A] placeholder:font-normal focus:outline-none focus:border-[#E2231A]"
        />
      </div>
      {abierto && resultados.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-[#161D14] border border-[#2A332C] rounded-lg overflow-hidden shadow-lg max-h-64 overflow-y-auto">
          {resultados.map((r) => (
            <button
              key={r.sku}
              type="button"
              onClick={() => seleccionar(r)}
              className="w-full text-left px-3 py-2.5 hover:bg-[#1B2119] active:bg-[#232B20] border-b border-[#2A332C] last:border-b-0"
            >
              <div className="mono text-sm font-bold" style={{ color: "#EDEAE2" }}>{r.sku}</div>
              <div className="text-[11px] truncate" style={{ color: "#8A9389" }}>{r.nombre}</div>
            </button>
          ))}
        </div>
      )}
      {abierto && texto.trim() && resultados.length === 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-[#161D14] border border-[#2A332C] rounded-lg px-3 py-2.5 text-[11px]" style={{ color: "#F2C879" }}>
          Sin coincidencias en el catálogo — verifica el número.
        </div>
      )}
    </div>
  );
}

function ModalCantidadPT({ etiqueta, catalogoPT, onConfirmar, onCancelar }) {
  const [cantidad, setCantidad] = useState("39");
  const [unidad, setUnidad] = useState("tarimas");
  // El código de barras NUNCA trae el SKU (solo Orden + Robot) — si no vino
  // de OCR ni de un catálogo de demo, hay que pedirlo a mano aquí mismo,
  // en vez de dejar "SKU ?" y confundir con el número de Orden.
  const necesitaSkuManual = !etiqueta.productoId || etiqueta.productoId === "?";
  const [skuManual, setSkuManual] = useState("");
  const skuEfectivo = necesitaSkuManual ? skuManual.trim() : etiqueta.productoId;

  const skuInfo = catalogoPT[skuEfectivo];
  const cajasXTarimaCatalogo = skuInfo?.cajasXTarima ?? null;
  const [cajasPorTarimaManual, setCajasPorTarimaManual] = useState(
    etiqueta.cajasXPalet ? String(etiqueta.cajasXPalet) : ""
  );
  const [ubicacion, setUbicacion] = useState(UBICACIONES_DEMO[0]);
  const [ubicacionLibre, setUbicacionLibre] = useState("");
  // El código de barras tampoco trae la fecha de máxima frescura (solo el
  // OCR de esa franja del banner la puede leer, y "Con etiqueta" no usa
  // OCR) — si no vino ya resuelta, se captura aquí mismo, igual que en la
  // captura sin etiqueta.
  const necesitaFechaManual = !etiqueta.agrupadorCaducidad;
  const [fechaManual, setFechaManual] = useState(etiqueta.agrupadorCaducidad || hoyISO());
  const fechaEfectiva = necesitaFechaManual ? fechaManual : etiqueta.agrupadorCaducidad;

  const nombre = skuInfo?.nombre || (skuEfectivo ? `SKU ${skuEfectivo}` : "¿Qué SKU es?");
  const cajasXTarimaEfectivo = cajasXTarimaCatalogo ?? (Number(cajasPorTarimaManual) || null);

  const totalCajas =
    unidad === "tarimas" && cantidad && cajasXTarimaEfectivo
      ? Number(cantidad) * cajasXTarimaEfectivo
      : null;

  const puedeConfirmar =
    !!skuEfectivo &&
    !!fechaEfectiva &&
    cantidad && Number(cantidad) > 0 &&
    (unidad === "cajas" || (cajasXTarimaEfectivo && cajasXTarimaEfectivo > 0)) &&
    (ubicacion !== "Otros" || ubicacionLibre.trim());

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-[#161D14] border border-[#2A332C] rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] text-[#8A9389] tracking-wide">CONFIRMAR ESCANEO</div>
            <div className="text-base font-bold mt-0.5 text-[#EDEAE2]">{nombre}</div>
            <div className="mono text-[11px] text-[#8A9389] mt-1">
              Orden {etiqueta.ordenProduccion || "—"} · Línea {etiqueta.linea || "—"}
            </div>
            {etiqueta.detalleTecnico && (
              <div className="text-[10px] text-[#6E776A] mt-1">{etiqueta.detalleTecnico}</div>
            )}
          </div>
          <button onClick={onCancelar} className="text-[#6E776A] hover:text-[#EDEAE2]">
            <X size={20} />
          </button>
        </div>

        {necesitaSkuManual && (
          <div>
            <label className="text-[11px] text-[#F2C879] tracking-wide block mb-1.5">
              SKU — el código de barras no lo trae, busca el producto
            </label>
            <BuscadorSKU catalogoPT={catalogoPT} valor={skuManual} onSeleccionar={setSkuManual} autoFocus />
            {skuManual && !skuInfo && (
              <div className="text-[11px] text-[#F2C879] mt-1.5">Ese SKU no está en la base de datos — puedes seguir, pero verifica que el número sea correcto.</div>
            )}
          </div>
        )}


        {necesitaFechaManual ? (
          <div>
            <label className="text-[11px] text-[#F2C879] tracking-wide block mb-1.5">
              FECHA DE MÁXIMA FRESCURA — la del banner negro en la etiqueta
            </label>
            <div className="relative">
              <Calendar size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6E776A]" />
              <input
                type="date"
                value={fechaManual}
                onChange={(e) => setFechaManual(e.target.value)}
                style={{ color: "#EDEAE2", boxSizing: "border-box", WebkitAppearance: "none", appearance: "none" }}
                className="w-full max-w-full block mono bg-[#1B2119] border border-[#F2C879] rounded-lg pl-9 pr-3 py-3 text-sm focus:outline-none focus:border-[#E2231A]"
              />
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 bg-[#1B2119] border border-[#2A332C] rounded-lg p-3 text-[11px] text-[#8A9389]">
            <AlertTriangle size={14} className="text-[#F2C879] mt-0.5 shrink-0" />
            Esta fecha de caducidad ({formatFecha(etiqueta.agrupadorCaducidad)}) aplica a todo el bloque que estás registrando.
          </div>
        )}

        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">CANTIDAD</label>
          <input
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            min="1"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            style={{ color: "#EDEAE2" }}
            className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-3 text-lg font-bold focus:outline-none focus:border-[#E2231A]"
            autoFocus
          />
        </div>

        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">UNIDAD</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setUnidad("tarimas")}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium ${unidad === "tarimas" ? "bg-[#E2231A] text-white border-[#E2231A]" : "bg-[#1B2119] border-[#2A332C] text-[#C9CFC5]"}`}
            >
              <Layers size={16} /> Tarimas
            </button>
            <button
              onClick={() => setUnidad("cajas")}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium ${unidad === "cajas" ? "bg-[#E2231A] text-white border-[#E2231A]" : "bg-[#1B2119] border-[#2A332C] text-[#C9CFC5]"}`}
            >
              <Boxes size={16} /> Cajas
            </button>
          </div>
        </div>

        {unidad === "tarimas" && (
          <div>
            <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">CAJAS POR TARIMA</label>
            {cajasXTarimaCatalogo ? (
              <div className="bg-[#15201A] border border-[#2A332C] rounded-lg px-3 py-2.5 flex items-center justify-between">
                <span className="text-[11px] text-[#9FD3A6]">✓ De la base de datos</span>
                <span className="mono text-sm font-bold text-[#9FD3A6]">{cajasXTarimaCatalogo} cajas/tarima</span>
              </div>
            ) : (
              <>
                <input
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min="1"
                  value={cajasPorTarimaManual}
                  onChange={(e) => setCajasPorTarimaManual(e.target.value)}
                  placeholder={etiqueta.cajasXPalet ? String(etiqueta.cajasXPalet) : "Ej. 40"}
                  className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-3 text-base font-bold placeholder:text-[#4A524A] placeholder:font-normal focus:outline-none focus:border-[#E2231A]"
                />
                {etiqueta.cajasXPalet ? (
                  <div className="text-[11px] text-[#9FD3A6] mt-1.5">✓ Tomado de la etiqueta ({etiqueta.cajasXPalet} cajas/palet)</div>
                ) : (
                  <div className="text-[11px] text-[#F2C879] mt-1.5">SKU no está en la base de datos — captúralo manualmente</div>
                )}
              </>
            )}
            {totalCajas !== null && (
              <div className="mt-1.5 text-[11px] text-[#9FD3A6] mono">
                = {cantidad} × {cajasXTarimaEfectivo} = <span className="font-bold">{totalCajas} cajas</span> en total
              </div>
            )}
          </div>
        )}

        <SelectorUbicacion ubicacion={ubicacion} setUbicacion={setUbicacion} ubicacionLibre={ubicacionLibre} setUbicacionLibre={setUbicacionLibre} />

        <button
          onClick={() => onConfirmar({
            productoId: skuEfectivo,
            agrupadorCaducidad: fechaEfectiva,
            cantidad: Number(cantidad) || 1,
            unidad,
            cajasXTarima: unidad === "tarimas" ? cajasXTarimaEfectivo : null,
            ubicacion: ubicacion === "Otros" ? (ubicacionLibre.trim() || "Otros") : ubicacion,
          })}
          disabled={!puedeConfirmar}
          className="w-full bg-[#E2231A] text-white font-bold py-3.5 rounded-xl disabled:opacity-40"
        >
          Confirmar y agregar
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// FORMULARIO MANUAL — Producto Terminado
// submodo "tpm": pide fecha (lote) | submodo "sin_fechas": no pide fecha
// ===========================================================================
function FormularioPTManual({ submodo, catalogoPT, onAgregar }) {
  const [material, setMaterial] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [unidad, setUnidad] = useState("tarimas");
  const [cajasPorTarimaManual, setCajasPorTarimaManual] = useState("");
  const [ubicacion, setUbicacion] = useState(UBICACIONES_DEMO[0]);
  const [ubicacionLibre, setUbicacionLibre] = useState("");
  const [fecha, setFecha] = useState(hoyISO());
  const [error, setError] = useState(null);

  const skuInfo = catalogoPT[material.trim()];
  const nombreSugerido = skuInfo?.nombre;
  const cajasXTarimaCatalogo = skuInfo?.cajasXTarima ?? null;
  const cajasXTarimaEfectivo = cajasXTarimaCatalogo ?? (Number(cajasPorTarimaManual) || null);

  const totalCajas = unidad === "tarimas" && cantidad && cajasXTarimaEfectivo ? Number(cantidad) * cajasXTarimaEfectivo : null;

  const limpiar = () => { setMaterial(""); setCantidad(""); setCajasPorTarimaManual(""); setUbicacionLibre(""); setError(null); };

  const submit = () => {
    if (!material.trim()) return setError("Ingresa el material (SKU).");
    if (!cantidad || Number(cantidad) <= 0) return setError("Ingresa una cantidad válida.");
    if (unidad === "tarimas" && !cajasXTarimaEfectivo) return setError("Este SKU no está en la base de datos. Ingresa cuántas cajas trae cada tarima.");
    if (ubicacion === "Otros" && !ubicacionLibre.trim()) return setError("Especifica la ubicación.");
    onAgregar({
      productoId: material.trim(),
      cantidad: Number(cantidad),
      unidad,
      cajasXTarima: unidad === "tarimas" ? cajasXTarimaEfectivo : null,
      ubicacion: ubicacion === "Otros" ? ubicacionLibre.trim() : ubicacion,
      agrupadorCaducidad: submodo === "tpm" ? fecha : null,
      esManual: true,
    });
    limpiar();
  };

  return (
    <div className="bg-[#161D14] border border-[#2A332C] rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2 text-[#E2231A]">
        <PenLine size={16} />
        <span className="text-sm font-bold" style={{ color: "#E2231A" }}>Captura sin etiqueta</span>
      </div>

      <div>
        <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">MATERIAL (SKU)</label>
        <BuscadorSKU catalogoPT={catalogoPT} valor={material} onSeleccionar={setMaterial} />
        {nombreSugerido && <div className="text-[11px] text-[#9FD3A6] mt-1.5">✓ {nombreSugerido}</div>}
        {material.trim() && !nombreSugerido && <div className="text-[11px] text-[#F2C879] mt-1.5">No está en la base de datos — se guardará para revisión</div>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">CANTIDAD</label>
          <input
            type="number" inputMode="numeric" pattern="[0-9]*" min="1"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            placeholder="Ej. 39"
            className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-3 text-base font-bold placeholder:text-[#4A524A] placeholder:font-normal focus:outline-none focus:border-[#E2231A]"
          />
        </div>
        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">UNIDAD</label>
          <div className="grid grid-cols-2 gap-1.5 h-[46px]">
            <button onClick={() => setUnidad("tarimas")} className={`flex items-center justify-center rounded-lg border text-xs font-medium ${unidad === "tarimas" ? "bg-[#E2231A] text-white border-[#E2231A]" : "bg-[#1B2119] border-[#2A332C] text-[#C9CFC5]"}`}>Tarimas</button>
            <button onClick={() => setUnidad("cajas")} className={`flex items-center justify-center rounded-lg border text-xs font-medium ${unidad === "cajas" ? "bg-[#E2231A] text-white border-[#E2231A]" : "bg-[#1B2119] border-[#2A332C] text-[#C9CFC5]"}`}>Cajas</button>
          </div>
        </div>
      </div>

      {unidad === "tarimas" && (
        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">CAJAS POR TARIMA</label>
          {cajasXTarimaCatalogo ? (
            <div className="bg-[#15201A] border border-[#2A332C] rounded-lg px-3 py-2.5 flex items-center justify-between">
              <span className="text-[11px] text-[#9FD3A6]">✓ De la base de datos</span>
              <span className="mono text-sm font-bold text-[#9FD3A6]">{cajasXTarimaCatalogo} cajas/tarima</span>
            </div>
          ) : (
            <>
              <input
                type="number" inputMode="numeric" pattern="[0-9]*" min="1"
                value={cajasPorTarimaManual}
                onChange={(e) => setCajasPorTarimaManual(e.target.value)}
                placeholder="Ej. 40"
                disabled={!material.trim()}
                className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-3 text-base font-bold placeholder:text-[#4A524A] placeholder:font-normal focus:outline-none focus:border-[#E2231A] disabled:opacity-40"
              />
              {material.trim() && <div className="text-[11px] text-[#F2C879] mt-1.5">SKU no encontrado en la base de datos — captúralo manualmente</div>}
            </>
          )}
          {totalCajas !== null && (
            <div className="mt-1.5 text-[11px] text-[#9FD3A6] mono">
              = {cantidad} × {cajasXTarimaEfectivo} = <span className="font-bold">{totalCajas} cajas</span> en total
            </div>
          )}
        </div>
      )}

      <SelectorUbicacion ubicacion={ubicacion} setUbicacion={setUbicacion} ubicacionLibre={ubicacionLibre} setUbicacionLibre={setUbicacionLibre} />

      {submodo === "tpm" && (
        <div>
          <label className="text-[11px] text-[#8A9389] tracking-wide block mb-1.5">FECHA DE MÁXIMA FRESCURA</label>
          <div className="relative">
            <Calendar size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6E776A]" />
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              style={{ color: "#EDEAE2", boxSizing: "border-box", WebkitAppearance: "none", appearance: "none" }}
              className="w-full max-w-full block mono bg-[#1B2119] border border-[#2A332C] rounded-lg pl-9 pr-3 py-3 text-sm focus:outline-none focus:border-[#E2231A]"
            />
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-[#2A1818] border border-[#5A2A2A] rounded-lg p-3 text-sm text-[#E8A8A8]">
          <XCircle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <button onClick={submit} className="w-full bg-[#E2231A] text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
        <PenLine size={18} /> Agregar al inventario
      </button>
    </div>
  );
}

// ===========================================================================
// FORMULARIO — Materiales Retornables (siempre manual, sin fecha, por familia)
// ===========================================================================
// ===========================================================================
// FILA DE CAPTURA — una por SKU, estilo tabla compacta (como el Excel de planta)
// Cada fila mantiene su propio estado de tarima/restos, muestra historial de
// las últimas capturas de ESE SKU, y el total acumulado en la sesión.
// ===========================================================================
function FilaRetornable({ clave, info, catalogoFamilia, registrosDeEsteSku, omitirRestos, onAgregar }) {
  const [factorElegido, setFactorElegido] = useState(info.factorDefault ?? (info.factores ? info.factores[0] : null));
  const [editandoFactor, setEditandoFactor] = useState(false);

  // "Carrito" de estibas capturadas en esta ronda, antes de confirmar el bloque.
  // Cada Enter en el campo de tarima la agrega a la lista y limpia el campo
  // para seguir capturando la siguiente estiba sin perder las anteriores.
  const [estibas, setEstibas] = useState([]); // [12, 8, 15, ...] tarimas completas por estiba
  const [restosLista, setRestosLista] = useState([]); // restos capturados igual, por Enter
  const [tarimaActual, setTarimaActual] = useState("");
  const [restoActual, setRestoActual] = useState("");
  const [estado, setEstado] = useState(info.requiereEstado ? info.requiereEstado[0] : null);

  const inputTarimaRef = useRef(null);
  const inputRestoRef = useRef(null);

  // Historial: últimas capturas YA CONFIRMADAS (registros guardados) de este SKU
  const historialTarimas = registrosDeEsteSku.filter((r) => r.tarimasCompletas != null).slice(0, 3).map((r) => r.tarimasCompletas);
  const historialRestos = registrosDeEsteSku.filter((r) => r.restos != null).slice(0, 3).map((r) => r.restos);
  const totalAcumulado = registrosDeEsteSku.reduce((sum, r) => sum + (r.cantidad || 0), 0);

  // Implícito simple (envase -> caja, ej. 170460 -> 170451): la caja siempre lleva
  // el MISMO NÚMERO DE PIEZAS que el envase capturado, sin importar qué factor haya
  // elegido el usuario para el envase (por eso no se busca un factor aparte para la
  // caja: se usa directamente el total de piezas ya calculado del envase).
  // Implícito explícito (ej. garrafón -> tarima/módulo de rack): usa porTarima tal cual,
  // porque ahí la relación es piezas-por-tarima-de-envase, no piezas-por-piezas.
  const listaImplicitos = info.implicitos
    ? info.implicitos
    : info.implicito
    ? [{ ...info.implicito, esSimple: true }]
    : [];

  const sumaEstibas = estibas.reduce((s, v) => s + v, 0);
  const sumaRestosLista = restosLista.reduce((s, v) => s + v, 0);

  const agregarEstibaActual = () => {
    const v = Number(tarimaActual);
    if (v > 0) setEstibas((prev) => [...prev, v]);
    setTarimaActual("");
    // mantiene el foco para seguir tecleando la siguiente estiba sin tocar la pantalla
    requestAnimationFrame(() => inputTarimaRef.current?.focus());
  };

  const agregarRestoActual = () => {
    const v = Number(restoActual);
    if (v > 0) setRestosLista((prev) => [...prev, v]);
    setRestoActual("");
    requestAnimationFrame(() => inputRestoRef.current?.focus());
  };

  const quitarEstiba = (i) => setEstibas((prev) => prev.filter((_, idx) => idx !== i));
  const quitarResto = (i) => setRestosLista((prev) => prev.filter((_, idx) => idx !== i));

  // Total final = (suma de todas las estibas + lo que quede sin confirmar en el campo) × factor
  //              + (suma de todos los restos + lo que quede sin confirmar en el campo)
  const tarimasFinal = sumaEstibas + (Number(tarimaActual) || 0);
  const restosFinal = omitirRestos ? 0 : sumaRestosLista + (Number(restoActual) || 0);
  const totalPiezasPreview = info.esPieza ? tarimasFinal : tarimasFinal * (factorElegido || 0) + restosFinal;

  const hayAlgoQueGuardar = info.esPieza ? tarimasFinal > 0 : (tarimasFinal > 0 || restosFinal > 0);

  const confirmarBloque = () => {
    if (!hayAlgoQueGuardar) return;

    onAgregar({
      productoId: info.sku,
      claveCatalogo: clave,
      nombre: info.nombre,
      cantidad: totalPiezasPreview,
      tarimasCompletas: info.esPieza ? null : tarimasFinal,
      restos: info.esPieza || omitirRestos ? null : restosFinal,
      factor: info.esPieza ? null : factorElegido,
      estado,
    });

    listaImplicitos.forEach((imp) => {
      const cantImp = imp.esSimple ? totalPiezasPreview : tarimasFinal * imp.porTarima;
      if (cantImp > 0) {
        onAgregar({
          productoId: imp.sku, claveCatalogo: imp.sku, nombre: imp.nombre,
          cantidad: cantImp, tarimasCompletas: null, restos: null, factor: null, estado: null,
          esImplicito: true, deSku: info.sku,
        });
      }
    });

    setEstibas([]); setRestosLista([]); setTarimaActual(""); setRestoActual("");
    // Regresa el foco al campo de tarima de inmediato para que el teclado
    // móvil no se cierre entre una confirmación y la siguiente captura.
    requestAnimationFrame(() => inputTarimaRef.current?.focus());
  };

  const onKeyDownTarima = (e) => {
    if (e.key === "Enter") { e.preventDefault(); agregarEstibaActual(); }
  };
  const onKeyDownResto = (e) => {
    if (e.key === "Enter") { e.preventDefault(); agregarRestoActual(); }
  };

  return (
    <div className="bg-[#161D14] border border-[#2A332C] rounded-xl p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mono text-[11px] text-[#E2231A] font-bold">{info.sku}</div>
          <div className="text-[13px] text-[#EDEAE2] font-medium leading-snug">{info.nombre}</div>
        </div>
        {totalAcumulado > 0 && (
          <div className="shrink-0 text-right">
            <div className="mono text-base font-bold text-[#9FD3A6]">{Math.round(totalAcumulado)}</div>
            <div className="text-[9px] text-[#6E776A]">total guardado</div>
          </div>
        )}
      </div>

      {info.requiereEstado && (
        <div className="grid grid-cols-2 gap-1.5">
          {info.requiereEstado.map((est) => (
            <button
              key={est}
              onClick={() => setEstado(est)}
              className={`py-1.5 rounded-md border text-xs font-medium ${estado === est ? "bg-[#E2231A] text-white border-[#E2231A]" : "bg-[#1B2119] border-[#2A332C] text-[#C9CFC5]"}`}
            >
              {est}
            </button>
          ))}
        </div>
      )}

      <div className={`grid ${info.esPieza ? "grid-cols-[auto_1fr]" : "grid-cols-[auto_1fr_1fr]"} gap-2 items-end`}>
        {/* CJ x TAR — editable directo: toca para escribir cualquier valor */}
        {!info.esPieza && (
          <div className="relative">
            {editandoFactor ? (
              <input
                type="number" inputMode="decimal" min="0" step="any" autoFocus
                value={factorElegido ?? ""}
                onChange={(e) => setFactorElegido(e.target.value === "" ? "" : Number(e.target.value))}
                onBlur={() => setEditandoFactor(false)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditandoFactor(false); inputTarimaRef.current?.focus(); } }}
                className="w-14 mono text-xs font-bold bg-[#1B2119] border border-[#E2231A] rounded-md px-1.5 py-2 text-[#EDEAE2] text-center focus:outline-none"
              />
            ) : (
              <button
                onClick={() => setEditandoFactor(true)}
                onMouseDown={(e) => e.preventDefault()}
                className="mono text-xs font-bold bg-[#1B2119] border border-[#2A332C] rounded-md px-2 py-2 text-[#C9CFC5] flex items-center gap-1 whitespace-nowrap"
              >
                ×{factorElegido}
                <PenLine size={10} className="text-[#6E776A]" />
              </button>
            )}
            {info.factores?.length > 1 && !editandoFactor && (
              <div className="flex gap-1 mt-1">
                {info.factores.map((f) => (
                  <button
                    key={f}
                    onClick={() => setFactorElegido(f)}
                    className={`mono text-[9px] rounded px-1.5 py-0.5 ${factorElegido === f ? "bg-[#E2231A] text-white" : "bg-[#1B2119] text-[#6E776A]"}`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tarima completa / cantidad — captura con Enter para seguir sumando */}
        <div>
          <input
            ref={inputTarimaRef}
            type="number" inputMode="numeric" pattern="[0-9]*" min="0"
            value={tarimaActual}
            onChange={(e) => setTarimaActual(e.target.value)}
            onKeyDown={onKeyDownTarima}
            placeholder={info.esPieza ? "Cant. ↵" : "Tarimas ↵"}
            className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-md px-2 py-2 text-sm font-bold text-center placeholder:text-[#4A524A] placeholder:font-normal placeholder:text-[10px] focus:outline-none focus:border-[#E2231A]"
          />
          {estibas.length > 0 && (
            <div className="flex gap-1 mt-1 justify-center flex-wrap">
              {estibas.map((v, i) => (
                <button key={i} onClick={() => quitarEstiba(i)} className="mono text-[9px] bg-[#15201A] text-[#9FD3A6] rounded px-1.5 py-0.5 flex items-center gap-0.5">
                  {v} <X size={8} />
                </button>
              ))}
            </div>
          )}
          {estibas.length === 0 && historialTarimas.length > 0 && (
            <div className="flex gap-1 mt-1 justify-center">
              {historialTarimas.map((v, i) => (
                <span key={i} className="mono text-[9px] bg-[#1B2119] text-[#6E776A] rounded px-1.5 py-0.5">{Math.round(v)}</span>
              ))}
            </div>
          )}
        </div>

        {/* Restos — mismo patrón de Enter */}
        {!info.esPieza && !omitirRestos && (
          <div>
            <input
              ref={inputRestoRef}
              type="number" inputMode="numeric" pattern="[0-9]*" min="0"
              value={restoActual}
              onChange={(e) => setRestoActual(e.target.value)}
              onKeyDown={onKeyDownResto}
              placeholder="Restos ↵"
              className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-md px-2 py-2 text-sm font-bold text-center placeholder:text-[#4A524A] placeholder:font-normal placeholder:text-[10px] focus:outline-none focus:border-[#E2231A]"
            />
            {restosLista.length > 0 && (
              <div className="flex gap-1 mt-1 justify-center flex-wrap">
                {restosLista.map((v, i) => (
                  <button key={i} onClick={() => quitarResto(i)} className="mono text-[9px] bg-[#15201A] text-[#9FD3A6] rounded px-1.5 py-0.5 flex items-center gap-0.5">
                    {v} <X size={8} />
                  </button>
                ))}
              </div>
            )}
            {restosLista.length === 0 && historialRestos.length > 0 && (
              <div className="flex gap-1 mt-1 justify-center">
                {historialRestos.map((v, i) => (
                  <span key={i} className="mono text-[9px] bg-[#1B2119] text-[#6E776A] rounded px-1.5 py-0.5">{Math.round(v)}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {(estibas.length > 0 || restosLista.length > 0 || tarimaActual || restoActual) && (
        <div className="text-[11px] text-[#9FD3A6] mono bg-[#0E1410] rounded-lg px-2.5 py-2">
          {!info.esPieza ? (
            <>= {tarimasFinal} × {factorElegido}{restosFinal ? ` + ${restosFinal}` : ""} = <span className="font-bold">{Math.round(totalPiezasPreview)} piezas</span></>
          ) : (
            <>= <span className="font-bold">{Math.round(totalPiezasPreview)} piezas</span></>
          )}
        </div>
      )}

      {listaImplicitos.length > 0 && tarimasFinal > 0 && (
        <div className="text-[10px] text-[#9FD3A6] flex flex-wrap gap-x-2">
          {listaImplicitos.map((imp) => (
            <span key={imp.sku}>+ {Math.round(imp.esSimple ? totalPiezasPreview : tarimasFinal * imp.porTarima)} {imp.nombre}</span>
          ))}
        </div>
      )}

      <button
        onClick={confirmarBloque}
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={(e) => e.preventDefault()}
        disabled={!hayAlgoQueGuardar}
        style={
          hayAlgoQueGuardar
            ? { backgroundColor: "#3FA85C", color: "#FFFFFF", borderColor: "#3FA85C" }
            : { backgroundColor: "#2A332C", color: "#8A9389", borderColor: "#4A524A" }
        }
        className="w-full font-bold py-2.5 rounded-lg text-sm flex items-center justify-center gap-1.5 transition-transform border-2 active:scale-[0.98] disabled:active:scale-100"
      >
        <CheckCircle2 size={15} color={hayAlgoQueGuardar ? "#FFFFFF" : "#8A9389"} /> Confirmar bloque
      </button>
    </div>
  );
}

// ===========================================================================
// LISTA DE RETORNABLES — todas las filas del catálogo de la familia, con buscador
// ===========================================================================
function FormularioRetornable({ familiaId, catalogoRetornables, escaneos, onAgregar }) {
  const familia = FAMILIAS_RETORNABLES.find((f) => f.id === familiaId);
  const catalogoFamilia = catalogoRetornables[familiaId] || {};
  // Object.entries reordena claves que parecen enteros (ej. "170451") de forma
  // numérica ascendente, ignorando el orden de escritura. Por eso cada entrada
  // del catálogo lleva un campo `orden` explícito, y se ordena por ahí.
  const entradas = Object.entries(catalogoFamilia).sort(([, a], [, b]) => (a.orden ?? 0) - (b.orden ?? 0));
  const [filtro, setFiltro] = useState("");

  const omitirRestos = familiaId === "tarimas" || familiaId === "embalaje";

  const entradasFiltradas = filtro.trim()
    ? entradas.filter(([, info]) => info.sku.includes(filtro.trim()) || info.nombre.toLowerCase().includes(filtro.trim().toLowerCase()))
    : entradas;

  const registrosPorSku = (sku) => escaneos.filter((e) => e.familiaId === familiaId && e.productoId === sku);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[#E2231A] px-1">
        {familia && <familia.icon size={18} />}
        <span className="text-sm font-bold" style={{ color: "#E2231A" }}>{familia?.nombre}</span>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6E776A]" />
        <input
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          placeholder="Filtrar por SKU o nombre"
          className="w-full bg-[#1B2119] border border-[#2A332C] rounded-lg pl-9 pr-3 py-2.5 text-sm placeholder:text-[#4A524A] focus:outline-none focus:border-[#E2231A]"
        />
      </div>

      <div className="space-y-2.5">
        {entradasFiltradas.map(([clave, info]) => (
          <FilaRetornable
            key={clave}
            clave={clave}
            info={info}
            catalogoFamilia={catalogoFamilia}
            registrosDeEsteSku={registrosPorSku(info.sku)}
            omitirRestos={omitirRestos}
            onAgregar={(datos) => onAgregar({ ...datos, familiaId })}
          />
        ))}
        {entradasFiltradas.length === 0 && (
          <div className="text-center py-10 text-[#6E776A] text-sm">Sin resultados para "{filtro}".</div>
        )}
      </div>
    </div>
  );
}


// ===========================================================================
// ESCÁNER DE CÁMARA REAL — usa @zxing/library para leer el código de barras
// (Code 128) directamente del video de la cámara del dispositivo.
// ===========================================================================
function EscanerCamara({ onDetectado, flashOk }) {
  const videoRef = useRef(null);
  const [estado, setEstado] = useState("iniciando"); // iniciando | activo | permiso_denegado | sin_camara | error
  const [errorMsg, setErrorMsg] = useState("");
  const ultimaDeteccionRef = useRef(0);
  const trackRef = useRef(null);
  const [zoomCaps, setZoomCaps] = useState(null); // { min, max, step } o null si el dispositivo no lo soporta
  const [zoom, setZoom] = useState(null);
  const [torchDisponible, setTorchDisponible] = useState(false);
  const [torchActivo, setTorchActivo] = useState(false);

  useEffect(() => {
    // La planta usa 3 formatos reales: Code 128 (líneas de producción y
    // etiquetas manuales) y QR (productos que llegan de otras plantas).
    // OJO: BrowserMultiFormatReader IGNORA el filtro POSSIBLE_FORMATS para
    // códigos 2D — decodifica QR aunque no esté en la lista (confirmado
    // con pruebas) — así que de cualquier forma hay que asumir que puede
    // leer QR. Por eso lo incluimos explícitamente aquí, a propósito, en
    // vez de pelear contra ese comportamiento. TRY_HARDER activa el modo
    // de decodificación más agresivo, necesario para etiquetas reales
    // (borrosas, en ángulo, con poco contraste, o con brillo del plástico).
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.ITF,
      BarcodeFormat.EAN_13,
      BarcodeFormat.QR_CODE,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    let activo = true;

    async function iniciar() {
      try {
        await reader.decodeFromConstraints(
          {
            video: {
              facingMode: { ideal: "environment" },
              // Pedir explícitamente alta resolución: sin esto el navegador
              // suele entregar 640x480, insuficiente para leer un código de
              // barras real a la distancia normal de escaneo en planta.
              // Se pide hasta 4K "ideal" — el navegador entrega lo más
              // cercano que soporte el dispositivo, nunca falla por pedir
              // de más.
              width: { ideal: 3840 },
              height: { ideal: 2160 },
              // "continuous" ayuda en los navegadores que lo soportan a que
              // la cámara no se quede desenfocada en el fondo.
              advanced: [{ focusMode: "continuous" }],
            },
          },
          videoRef.current,
          (result, err) => {
            if (!activo) return;
            if (result) {
              const ahora = Date.now();
              if (ahora - ultimaDeteccionRef.current < 1200) return;
              ultimaDeteccionRef.current = ahora;
              onDetectado(result.getText());
            }
            if (err && !(err instanceof NotFoundException)) {
              console.warn("Error de lectura de cámara:", err);
            }
          }
        );
        if (activo) {
          setEstado("activo");
          // Zoom óptico/digital vía la Media Capture API — soportado en la
          // mayoría de Android (Chrome), muy limitado o inexistente en
          // iOS Safari (ahí el control simplemente no aparece). Acercar
          // así, sin mover el teléfono, ayuda mucho a que el código de
          // barras llene más el cuadro sin perder el enfoque.
          try {
            const stream = videoRef.current?.srcObject;
            const track = stream?.getVideoTracks?.()[0];
            if (track) {
              trackRef.current = track;
              const caps = track.getCapabilities?.();
              if (caps?.zoom) {
                setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
                const actual = track.getSettings?.()?.zoom;
                setZoom(actual ?? caps.zoom.min);
              }
              if (caps?.torch) setTorchDisponible(true);
            }
          } catch (err) {
            console.warn("Zoom de cámara no disponible:", err);
          }
        }
      } catch (err) {
        if (!activo) return;
        console.error("No se pudo iniciar la cámara:", err);
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          setEstado("permiso_denegado");
        } else if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
          setEstado("sin_camara");
        } else {
          setEstado("error");
          setErrorMsg(err?.message || "Error desconocido al iniciar la cámara.");
        }
      }
    }

    iniciar();

    return () => {
      activo = false;
      try { reader.reset(); } catch {}
    };
  }, [onDetectado]);

  const aplicarZoom = async (valor) => {
    setZoom(valor);
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ zoom: valor }] });
    } catch (err) {
      console.warn("No se pudo aplicar el zoom:", err);
    }
  };

  const toggleTorch = async () => {
    const nuevo = !torchActivo;
    try {
      await trackRef.current?.applyConstraints({ advanced: [{ torch: nuevo }] });
      setTorchActivo(nuevo);
    } catch (err) {
      console.warn("No se pudo activar la linterna:", err);
    }
  };

  return (
    <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#070A06] border border-[#2A332C]">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />

      {estado === "activo" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[72%] h-[42%] border-2 border-[#E2231A]/70 rounded-lg relative">
            <div className="absolute -top-px -left-px w-5 h-5 border-t-2 border-l-2 border-[#E2231A] rounded-tl-lg" />
            <div className="absolute -top-px -right-px w-5 h-5 border-t-2 border-r-2 border-[#E2231A] rounded-tr-lg" />
            <div className="absolute -bottom-px -left-px w-5 h-5 border-b-2 border-l-2 border-[#E2231A] rounded-bl-lg" />
            <div className="absolute -bottom-px -right-px w-5 h-5 border-b-2 border-r-2 border-[#E2231A] rounded-br-lg" />
            <div className="absolute left-0 right-0 top-0 h-0.5 bg-[#E2231A]/80 scanline" />
          </div>
        </div>
      )}

      {estado === "iniciando" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="w-7 h-7 border-3 rounded-full animate-spin" style={{ borderColor: "#2A332C", borderTopColor: "#E2231A" }} />
          <div className="text-[11px]" style={{ color: "#8A9389" }}>Iniciando cámara…</div>
        </div>
      )}

      {estado === "permiso_denegado" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <AlertTriangle size={28} style={{ color: "#F2C879" }} />
          <div className="text-sm font-bold" style={{ color: "#EDEAE2" }}>Permiso de cámara denegado</div>
          <div className="text-[11px]" style={{ color: "#8A9389" }}>
            Ve a los ajustes del navegador y permite el acceso a la cámara para este sitio, luego recarga la página.
          </div>
        </div>
      )}

      {estado === "sin_camara" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <Camera size={28} style={{ color: "#8A9389" }} />
          <div className="text-sm font-bold" style={{ color: "#EDEAE2" }}>No se detectó ninguna cámara</div>
          <div className="text-[11px]" style={{ color: "#8A9389" }}>Usa el campo de código manual debajo.</div>
        </div>
      )}

      {estado === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <XCircle size={28} style={{ color: "#E8A8A8" }} />
          <div className="text-sm font-bold" style={{ color: "#EDEAE2" }}>No se pudo iniciar la cámara</div>
          <div className="text-[11px]" style={{ color: "#8A9389" }}>{errorMsg}</div>
        </div>
      )}

      <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[10px] mono" style={{ color: "#8A9389" }}>
        <Camera size={12} />
        {estado === "activo" ? "CÁMARA ACTIVA" : "CÁMARA"}
      </div>

      {estado === "activo" && (zoomCaps || torchDisponible) && (
        <div className="absolute top-3 right-3 left-24 flex items-center gap-2">
          {zoomCaps && (
            <div className="flex-1 bg-black/50 rounded-lg px-3 py-2 flex items-center gap-2">
              <span className="text-[10px] mono shrink-0" style={{ color: "#C9CFC5" }}>ZOOM</span>
              <input
                type="range"
                min={zoomCaps.min}
                max={zoomCaps.max}
                step={zoomCaps.step}
                value={zoom ?? zoomCaps.min}
                onChange={(e) => aplicarZoom(Number(e.target.value))}
                className="w-full accent-[#E2231A]"
              />
            </div>
          )}
          {torchDisponible && (
            <button
              onClick={toggleTorch}
              className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: torchActivo ? "#E2231A" : "rgba(0,0,0,0.5)" }}
            >
              <Flashlight size={16} color="#FFFFFF" />
            </button>
          )}
        </div>
      )}

      {flashOk && (
        <div className="absolute inset-0 bg-[#9FD3A6] flash-overlay flex items-center justify-center">
          <CheckCircle2 size={48} className="text-[#0E1410]" />
        </div>
      )}

      {estado === "activo" && (
        <div className="absolute bottom-3 inset-x-3 text-center text-[11px]" style={{ color: "#8A9389" }}>
          Apunta al código de barras inferior de la etiqueta
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// ESCANEO INTELIGENTE — cámara + código de barras + OCR dirigido por campo.
// Flujo: 1) detecta el código de barras como siempre (rápido, confiable),
// 2) al detectarlo, congela un frame en alta resolución y corre el OCR
// (leerEtiquetaCompleta), 3) muestra una tarjeta de REVISIÓN con los 9 campos
// ya prellenados y editables — nunca se agrega nada sin que la persona lo
// confirme, porque el OCR de una etiqueta real nunca es 100% perfecto.
// ===========================================================================
function EscaneoInteligente({ catalogoPT, onCompletado }) {
  const videoRef = useRef(null);
  const [estadoCamara, setEstadoCamara] = useState("iniciando"); // iniciando | activo | error
  const [fase, setFase] = useState("escaneando"); // escaneando | leyendo | revision
  const [campos, setCampos] = useState(null);
  const [pendienteLocal, setPendienteLocal] = useState(null);
  const ultimaDeteccionRef = useRef(0);

  useEffect(() => {
    if (fase !== "escaneando") return;
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.EAN_13,
      BarcodeFormat.QR_CODE,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    let activo = true;

    async function iniciar() {
      try {
        await reader.decodeFromConstraints(
          {
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1920 }, height: { ideal: 1080 },
              advanced: [{ focusMode: "continuous" }],
            },
          },
          videoRef.current,
          async (result) => {
            if (!activo || fase !== "escaneando") return;
            if (!result) return;
            const ahora = Date.now();
            if (ahora - ultimaDeteccionRef.current < 1500) return;
            ultimaDeteccionRef.current = ahora;

            const codigo = result.getText();
            setFase("leyendo");

            // CRÍTICO: capturamos el frame AQUÍ, antes de reader.reset().
            // reset() detiene el stream de la cámara — si capturábamos
            // después (como antes), el video ya estaba en 0x0 y no había
            // nada que leer. Por eso siempre daba "videoWidth/Height = 0".
            let frame = null;
            try {
              const v = videoRef.current;
              const c = document.createElement("canvas");
              c.width = v.videoWidth;
              c.height = v.videoHeight;
              if (c.width > 0 && c.height > 0) {
                c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
                frame = c;
              }
            } catch (err) {
              console.error("No se pudo capturar el frame antes de detener la cámara:", err);
            }

            reader.reset();

            let mod = null;
            try {
              // Import dinámico: tesseract.js (pesado) solo se descarga aquí,
              // la primera vez que de verdad se detecta un código en modo
              // Inteligente — no en la carga inicial de la app.
              mod = await import("./ocrEtiqueta");
            } catch (err) {
              console.error("No se pudo cargar el módulo de OCR (¿sin internet?):", err);
            }

            if (!mod) {
              // Sin el módulo no hay forma de derivar nada — ni siquiera
              // Orden/Robot del código de barras. Se guarda al menos el
              // código crudo para no perder por completo el escaneo.
              setCampos({});
              setPendienteLocal({
                barcode: (codigo || "").replace(/\D/g, ""), productoId: "?",
                linea: "DESCONOCIDA", _confianzas: {},
              });
              setFase("revision");
              return;
            }

            try {
              if (!frame) throw new Error("No se pudo capturar la imagen de la cámara a tiempo.");
              // Límite de 10s: si el motor de OCR no responde (por ejemplo,
              // porque la red bloquea la descarga de tesseract.js desde su
              // CDN), no nos quedamos colgados — seguimos solo con el
              // código de barras en vez de congelar la pantalla.
              const conLimiteDeTiempo = (promesa, ms) =>
                Promise.race([
                  promesa,
                  new Promise((_, rej) => setTimeout(() => rej(new Error("OCR_TIMEOUT")), ms)),
                ]);

              const worker = await conLimiteDeTiempo(mod.obtenerWorkerOCR(), 10000);
              const camposDetectados = await conLimiteDeTiempo(mod.leerEtiquetaCompleta(worker, frame), 10000);
              const pend = mod.construirPendienteDesdeEscaneoInteligente({
                codigoBarras: codigo, campos: camposDetectados, catalogoPT,
              });
              setCampos(camposDetectados);
              setPendienteLocal(pend);
              setFase("revision");
            } catch (err) {
              const motivo = err?.message === "OCR_TIMEOUT"
                ? "El OCR no respondió en 10s (se siguió solo con el código de barras)."
                : `Error general de OCR: ${err?.message || err}`;
              if (err?.message === "OCR_TIMEOUT") console.warn(motivo); else console.error(motivo, err);
              // Si el OCR falla o se tarda demasiado, no perdemos el
              // escaneo: cae al flujo normal solo con el código de barras.
              const pend = mod.construirPendienteDesdeEscaneoInteligente({ codigoBarras: codigo, campos: {}, catalogoPT });
              setCampos({ _diagnostico: { version: "ocr-v7-fecha-maxima-frescura", textoCrudo: "(no llegó a leer texto)", numPalabrasDetectadas: 0, tamanoImagen: "—", errores: { general: motivo } } });
              setPendienteLocal(pend);
              setFase("revision");
            }
          }
        );
        if (activo) setEstadoCamara("activo");
      } catch (err) {
        console.error("No se pudo iniciar la cámara:", err);
        if (activo) setEstadoCamara("error");
      }
    }
    iniciar();
    return () => {
      activo = false;
      try { reader.reset(); } catch {}
    };
  }, [fase, catalogoPT]);

  const reintentar = () => {
    setCampos(null);
    setPendienteLocal(null);
    setFase("escaneando");
  };

  const confirmar = () => {
    onCompletado(pendienteLocal);
    reintentar();
  };

  const actualizarCampo = (campo, valor) => setPendienteLocal((p) => ({ ...p, [campo]: valor }));

  const badgeConfianza = (conf) => {
    if (conf == null) return null;
    const color = conf >= 80 ? "#9FD3A6" : conf >= 55 ? "#F2C879" : "#E8A8A8";
    const texto = conf >= 80 ? "alta" : conf >= 55 ? "revisar" : "baja — revisar";
    return <span className="text-[10px] font-medium" style={{ color }}>● confianza {texto}</span>;
  };

  if (fase === "revision" && pendienteLocal) {
    const c = pendienteLocal._confianzas || {};
    const campo = (etiqueta, key, confKey) => (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] text-[#8A9389] tracking-wide">{etiqueta}</label>
          {confKey && badgeConfianza(c[confKey])}
        </div>
        <input
          value={pendienteLocal[key] ?? ""}
          onChange={(e) => actualizarCampo(key, e.target.value)}
          style={{ color: "#EDEAE2" }}
          className="w-full mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#E2231A]"
        />
      </div>
    );
    return (
      <div className="space-y-3 bg-[#161D14] border border-[#2A332C] rounded-2xl p-4">
        <div className="text-[11px] text-[#8A9389] tracking-wide mb-1">REVISA LOS DATOS ANTES DE CONFIRMAR</div>
        {campo("SKU", "productoId", "sku")}
        {campo("CENTRO", "centro", "centro")}
        {campo("LÍNEA", "linea", "linea")}
        {campo("ORDEN DE PRODUCCIÓN", "ordenProduccion", null)}
        {campo("ROBOT", "codigoRobot", null)}
        {campo("NÚMERO DE TARIMA", "numeroTarima", "numeroTarima")}
        {campo("CAJAS / TARIMA", "cajasXPalet", "cajasXTarima")}
        {campo("FECHA Y HORA PRODUCCIÓN", "fechaProduccion", "fecha")}
        {campo("FECHA MÁXIMA FRESCURA (banner negro)", "agrupadorCaducidad", "caducidadImpresa")}
        {campo("CÓDIGO (barcode)", "barcode", null)}

        {campos?._diagnostico && (
          <details className="bg-[#1B2119] border border-[#2A332C] rounded-lg p-3">
            <summary className="text-[11px] text-[#8A9389] tracking-wide cursor-pointer">
              Detalle técnico (para soporte) — toca para ver/ocultar
            </summary>
            <div className="mt-2 space-y-1.5 text-[11px] text-[#C9CFC5]">
              <div className="text-[#9FD3A6]">Versión del código: <span className="mono">{campos._diagnostico.version || "anterior (sin marca)"}</span></div>
              <div>Tamaño de imagen: <span className="mono">{campos._diagnostico.tamanoImagen}</span></div>
              <div>Palabras detectadas: <span className="mono">{campos._diagnostico.numPalabrasDetectadas}</span></div>
              {Object.keys(campos._diagnostico.errores || {}).length > 0 && (
                <div className="text-[#F2C879]">
                  Errores por campo:
                  {Object.entries(campos._diagnostico.errores).map(([k, v]) => (
                    <div key={k} className="mono ml-2">• {k}: {v}</div>
                  ))}
                </div>
              )}
              <div>
                Texto crudo leído por el OCR:
                <pre className="mono whitespace-pre-wrap break-words bg-[#0E140F] rounded p-2 mt-1 text-[10px]">
                  {campos._diagnostico.textoCrudo}
                </pre>
              </div>
            </div>
          </details>
        )}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button onClick={reintentar} className="py-2.5 rounded-lg border border-[#2A332C] text-[#C9CFC5] text-sm font-medium active:scale-[0.98] transition-transform">
            Reintentar
          </button>
          <button onClick={confirmar} style={{ backgroundColor: "#E2231A" }} className="py-2.5 rounded-lg text-white text-sm font-bold active:scale-[0.98] transition-transform">
            Usar estos datos
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#070A06] border border-[#2A332C]">
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
      {fase === "leyendo" && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
          <div className="w-7 h-7 border-3 rounded-full animate-spin" style={{ borderColor: "#2A332C", borderTopColor: "#E2231A" }} />
          <div className="text-[11px]" style={{ color: "#EDEAE2" }}>Leyendo etiqueta (código + texto)…</div>
        </div>
      )}
      {estadoCamara === "iniciando" && fase === "escaneando" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-[11px]" style={{ color: "#8A9389" }}>Iniciando cámara…</div>
        </div>
      )}
      {estadoCamara === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <XCircle size={28} style={{ color: "#E8A8A8" }} />
          <div className="text-sm font-bold" style={{ color: "#EDEAE2" }}>No se pudo iniciar la cámara</div>
        </div>
      )}
      {estadoCamara === "activo" && fase === "escaneando" && (
        <div className="absolute bottom-3 inset-x-3 text-center text-[11px]" style={{ color: "#8A9389" }}>
          Apunta al código de barras — se leerá también el texto de la etiqueta
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// APP PRINCIPAL — maneja navegación entre módulos y todo el estado de sesión
// ===========================================================================
export default function InventarioApp() {

  // Catálogo cargado desde Supabase (una sola vez, al abrir la app)
  const [catalogoPT, setCatalogoPT] = useState(null);
  const [catalogoRetornables, setCatalogoRetornables] = useState(null);
  const [errorCarga, setErrorCarga] = useState(null);

  useEffect(() => {
    cargarCatalogoDesdeSupabase().then((res) => {
      if (res.ok) {
        setCatalogoPT(res.catalogoPT);
        setCatalogoRetornables(res.catalogoRetornables);
      } else {
        setErrorCarga(res.error);
      }
    });
  }, []);

  // Navegación: inicio -> (submodo_pt | familia_retornable) -> sesion
  const [pantalla, setPantalla] = useState("inicio");
  const [mostrarExportar, setMostrarExportar] = useState(false);
  const [modulo, setModulo] = useState(null);       // "producto_terminado" | "retornables"
  const [submodoPT, setSubmodoPT] = useState(null); // "tpm" | "sin_fechas"
  const [familiaId, setFamiliaId] = useState(null);

  const [vista, setVista] = useState("escaner");
  const [modoEscaneo, setModoEscaneo] = useState("manual");
  const [escaneos, setEscaneos] = useState([]);
  const [flashOk, setFlashOk] = useState(false);
  const [ultimoError, setUltimoError] = useState(null);
  const [demoIdx, setDemoIdx] = useState(0);
  const [inputManual, setInputManual] = useState("");
  const [pendiente, setPendiente] = useState(null);
  const [mostrarSync, setMostrarSync] = useState(false);
  const [ubicacionSesion, setUbicacionSesion] = useState(UBICACIONES_DEMO[0]);
  const [mostrarUbicacionSesion, setMostrarUbicacionSesion] = useState(false);
  const [ubicacionSesionLibre, setUbicacionSesionLibre] = useState("");
  const [sincronizado, setSincronizado] = useState(null); // { numEmpleado, nombre }
  const [sesionId, setSesionId] = useState(null); // UUID de la sesión actual en Supabase
  const [sincronizando, setSincronizando] = useState(false);
  const liveRegionRef = useRef(null);

  const reiniciarSesion = () => {
    setEscaneos([]);
    setVista("escaner");
    setModoEscaneo("manual");
    setSincronizado(null);
    setPantalla("inicio");
    setModulo(null);
    setSubmodoPT(null);
    setFamiliaId(null);
    setSesionId(null);
  };

  const elegirModulo = (m) => {
    setModulo(m);
    setPantalla(m === "producto_terminado" ? "submodo_pt" : "familia_retornable");
  };

  const elegirSubmodoPT = (sm) => {
    setSubmodoPT(sm);
    setPantalla("sesion");
  };

  const elegirFamilia = (f) => {
    setFamiliaId(f);
    setPantalla("sesion");
  };

  const catalogoActivo = modulo === "producto_terminado" ? catalogoPT : (catalogoRetornables?.[familiaId] || {});

  // Para retornables, varias entradas del catálogo pueden compartir el mismo SKU real
  // (ej. "170460" normal y "170460#granel"). Para comparar contra stock, se agrupa por
  // SKU real sumando sus stocks y usando el primer nombre no-granel como descripción.
  const catalogoPorSkuReal = useMemo(() => {
    if (!catalogoActivo) return {};
    if (modulo === "producto_terminado") return catalogoActivo;
    const agrupado = {};
    Object.values(catalogoActivo).forEach((info) => {
      if (!agrupado[info.sku]) agrupado[info.sku] = { nombre: info.nombre, stockSap: 0 };
      agrupado[info.sku].stockSap += info.stockSap || 0;
      if (!info.granel) agrupado[info.sku].nombre = info.nombre; // prioriza nombre no-granel
    });
    return agrupado;
  }, [catalogoActivo, modulo]);

  const confirmarYAgregar = useCallback((etiqueta, datos) => {
    const nuevo = {
      id: `${etiqueta.barcode || etiqueta.productoId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...etiqueta,
      ...datos,
    };
    setEscaneos((prev) => [nuevo, ...prev]);
    setFlashOk(true);
    setTimeout(() => setFlashOk(false), 380);
    if (liveRegionRef.current) {
      liveRegionRef.current.textContent = `Agregado: ${datos.cantidad} ${datos.unidad} de ${etiqueta.productoId} en ${datos.ubicacion}`;
    }
  }, []);

  const simularEscaneoCamara = () => {
    const etiqueta = ETIQUETAS_DEMO[demoIdx % ETIQUETAS_DEMO.length];
    const parsed = parseBarcode(etiqueta.barcode);
    if (!parsed.ok) return setUltimoError(parsed.error);
    setUltimoError(null);
    setPendiente({ ...etiqueta, ...parsed });
    setDemoIdx((i) => i + 1);
  };

  // Procesa cualquier código de barras leído (de la cámara real o tecleado a
  // mano) y prepara el modal de confirmación de cantidad. Ambas vías de
  // entrada convergen aquí para no duplicar la lógica de parseo/búsqueda.
  const procesarCodigoBarras = useCallback((codigoRaw) => {
    const parsed = parseBarcode(codigoRaw);
    if (!parsed.ok) {
      setUltimoError(parsed.error);
      return;
    }
    setUltimoError(null);
    const limpio = codigoRaw.replace(/\D/g, "");
    const match = ETIQUETAS_DEMO.find((e) => e.barcode === limpio);
    setPendiente(match ? { ...match, ...parsed } : {
      barcode: limpio, productoId: "?", agrupadorCaducidad: null,
      linea: "DESCONOCIDA", fechaProduccion: null, cajasXPalet: null, diasVida: null,
      ...parsed, // si el código trae productoId (formato "tarima"), pisa el "?" de arriba
    });
    setFlashOk(true);
    setTimeout(() => setFlashOk(false), 380);
  }, []);

  const escanearManualCodigo = () => {
    procesarCodigoBarras(inputManual);
    setInputManual("");
  };

  const agregarManualPT = (datos) => {
    confirmarYAgregar(
      { productoId: datos.productoId, agrupadorCaducidad: datos.agrupadorCaducidad, linea: "—", cajasXPalet: null, cajasXTarima: datos.cajasXTarima, esManual: true },
      { cantidad: datos.cantidad, unidad: datos.unidad, ubicacion: datos.ubicacion }
    );
  };

  const agregarRetornable = (datos) => {
    const ubicacionFinal = ubicacionSesion === "Otros" ? (ubicacionSesionLibre.trim() || "Otros") : ubicacionSesion;
    confirmarYAgregar(
      {
        productoId: datos.productoId,
        claveCatalogo: datos.claveCatalogo,
        nombre: datos.nombre,
        familiaId: datos.familiaId,
        agrupadorCaducidad: null,
        linea: "—",
        tarimasCompletas: datos.tarimasCompletas,
        restos: datos.restos,
        factor: datos.factor,
        estado: datos.estado,
        esImplicito: datos.esImplicito || false,
        deSku: datos.deSku || null,
        esManual: true,
      },
      { cantidad: datos.cantidad, unidad: "piezas", ubicacion: ubicacionFinal }
    );
  };

  const eliminarEscaneo = (id) => setEscaneos((prev) => prev.filter((e) => e.id !== id));

  // --- Cálculo de cajas equivalentes por producto (PT) o piezas por producto (retornables) ---
  const totalesPorSku = useMemo(() => {
    return escaneos.reduce((acc, e) => {
      const cantidadFinal = modulo === "producto_terminado"
        ? aCajasEquivalentes(e.cantidad, e.unidad, e.cajasXTarima)
        : e.cantidad;
      if (!acc[e.productoId]) acc[e.productoId] = { total: 0, lotes: [] };
      acc[e.productoId].total += cantidadFinal;
      acc[e.productoId].lotes.push({ fecha: e.agrupadorCaducidad, cantidad: cantidadFinal, ubicacion: e.ubicacion });
      return acc;
    }, {});
  }, [escaneos, modulo]);

  const comparacion = useMemo(() => {
    const skusUnion = new Set([...Object.keys(catalogoPorSkuReal), ...Object.keys(totalesPorSku)]);
    return Array.from(skusUnion).map((sku) => {
      const cat = catalogoPorSkuReal[sku];
      const escaneado = Math.round(totalesPorSku[sku]?.total || 0);
      const stockSap = cat ? cat.stockSap : 0;
      const diferencia = escaneado - stockSap;
      let tipo = "ok";
      if (!cat) tipo = "no_catalogado";
      else if (diferencia < 0) tipo = "faltante";
      else if (diferencia > 0) tipo = "sobrante";
      return {
        sku, nombre: cat ? cat.nombre : "No encontrado en la base de datos",
        stockSap, escaneado, diferencia, tipo,
        lotes: totalesPorSku[sku]?.lotes || [],
      };
    });
  }, [catalogoPorSkuReal, totalesPorSku]);

  const tituloModulo = modulo === "producto_terminado"
    ? (submodoPT === "tpm" ? "Producto Terminado · TPM" : "Producto Terminado · Sin fechas")
    : `Retornables · ${FAMILIAS_RETORNABLES.find((f) => f.id === familiaId)?.nombre || ""}`;

  const esTPM = modulo === "producto_terminado" && submodoPT === "tpm";
  const esRetornable = modulo === "retornables";

  // -------------------------------------------------------------------------
  // CARGA INICIAL DEL CATÁLOGO — bloquea todo hasta tener datos de Supabase
  // -------------------------------------------------------------------------
  if (errorCarga) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ backgroundColor: "#0E1410" }}>
        <AlertTriangle size={40} style={{ color: "#E8A8A8" }} />
        <div className="mt-4 text-center" style={{ color: "#EDEAE2" }}>
          <div className="font-bold mb-1">No se pudo cargar el catálogo</div>
          <div className="text-sm" style={{ color: "#8A9389" }}>{errorCarga}</div>
        </div>
      </div>
    );
  }
  if (!catalogoPT || !catalogoRetornables) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ backgroundColor: "#0E1410" }}>
        <div className="w-8 h-8 border-3 rounded-full animate-spin" style={{ borderColor: "#2A332C", borderTopColor: "#E2231A" }} />
        <div className="mt-4 text-sm" style={{ color: "#8A9389" }}>Cargando catálogo…</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // RUTEO DE PANTALLAS PREVIAS A LA SESIÓN
  // -------------------------------------------------------------------------
  if (pantalla === "inicio") {
    return (
      <>
        <PantallaInicio onElegirModulo={elegirModulo} onExportar={() => setMostrarExportar(true)} />
        {mostrarExportar && <ModalExportar onCerrar={() => setMostrarExportar(false)} />}
      </>
    );
  }
  if (pantalla === "submodo_pt") {
    return <PantallaSubmodoPT onElegir={elegirSubmodoPT} onVolver={() => setPantalla("inicio")} />;
  }
  if (pantalla === "familia_retornable") {
    return <PantallaFamilia onElegir={elegirFamilia} onVolver={() => setPantalla("inicio")} />;
  }

  // -------------------------------------------------------------------------
  // PANTALLA DE SESIÓN (escanear / revisar / comparar)
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#0E1410] text-[#EDEAE2] font-sans">
      <style>{`
        @keyframes scanline { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } }
        @keyframes flashPulse { 0% { opacity: 0; } 30% { opacity: 1; } 100% { opacity: 0; } }
        .flash-overlay { animation: flashPulse 0.38s ease-out; }
        .scanline { animation: scanline 2.2s linear infinite; }
        .mono { font-family: 'JetBrains Mono', 'Courier New', monospace; }
      `}</style>

      <header
        style={{ backgroundColor: "#E2231A", paddingTop: "calc(0.75rem + env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
        className="sticky top-0 z-20 px-4 flex items-center justify-between"
      >
        <div className="flex items-center gap-2.5">
          <button onClick={() => setPantalla(modulo === "producto_terminado" ? "submodo_pt" : "familia_retornable")} style={{ color: "#FFFFFF" }}>
            <ChevronLeft size={20} />
          </button>
          <div className="w-8 h-8 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: "#FFFFFF" }}>
            <Package size={18} style={{ color: "#E2231A" }} />
          </div>
          <div>
            <div className="font-bold text-sm leading-tight tracking-wide" style={{ color: "#FFFFFF" }}>{tituloModulo}</div>
            <div className="text-[10px] leading-tight" style={{ color: "#FFD9D5" }}>{PLANTA}</div>
          </div>
        </div>
        <div className="mono text-xs px-2.5 py-1 rounded shrink-0" style={{ backgroundColor: "#FFFFFF", color: "#E2231A" }}>
          {escaneos.length}
        </div>
      </header>

      <nav
        style={{ backgroundColor: "#10160F" }}
        className="flex border-b border-[#2A332C] sticky top-[57px] z-20"
      >
        {[
          { id: "escaner", label: "Escanear", icon: Scan },
          { id: "revision", label: "Revisar", icon: ClipboardList },
          { id: "comparacion", label: "Comparar", icon: Upload },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setVista(t.id)}
            style={{
              color: vista === t.id ? "#E2231A" : "#8A9389",
              borderBottomColor: vista === t.id ? "#E2231A" : "transparent",
            }}
            className="flex-1 flex flex-col items-center gap-1 py-2.5 text-xs font-medium transition-colors border-b-2"
          >
            <t.icon size={16} color={vista === t.id ? "#E2231A" : "#8A9389"} />
            {t.label}
          </button>
        ))}
      </nav>

      <main className="px-4 py-5 max-w-md mx-auto">
        {vista === "escaner" && (
          <div className="space-y-4">
            {!esRetornable && (
              <div className="grid grid-cols-1 gap-2">
                {/* Modo "Con etiqueta" (cámara/código de barras) oculto por
                    ahora — la lectura no resultó confiable con varios
                    diseños reales de etiqueta de planta. El código sigue
                    existiendo (componente EscanerCamara más abajo) por si
                    se retoma más adelante; solo se quitó el botón. */}
                {/* Modo "Inteligente" (OCR) oculto por ahora — no daba
                    resultados confiables en pruebas reales de planta.
                    El código sigue existiendo (componente EscaneoInteligente
                    más abajo) por si se retoma más adelante; solo se quitó
                    el botón para que nadie lo use mientras tanto. */}
                <button
                  onClick={() => setModoEscaneo("manual")}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium ${modoEscaneo === "manual" ? "bg-[#E2231A] text-white border-[#E2231A]" : "bg-[#1B2119] border-[#2A332C] text-[#C9CFC5]"}`}
                >
                  <PenLine size={16} /> Sin etiqueta
                </button>
              </div>
            )}

            {esRetornable && (
              <button
                onClick={() => setMostrarUbicacionSesion(true)}
                className="w-full bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-2.5 flex items-center justify-between"
              >
                <span className="flex items-center gap-2 text-sm text-[#C9CFC5]">
                  <MapPin size={15} className="text-[#E2231A]" /> Ubicación
                </span>
                <span className="text-sm font-bold text-[#EDEAE2]">
                  {ubicacionSesion === "Otros" ? (ubicacionSesionLibre || "Otros") : ubicacionSesion}
                </span>
              </button>
            )}

            {esRetornable ? (
              <FormularioRetornable familiaId={familiaId} catalogoRetornables={catalogoRetornables} escaneos={escaneos} onAgregar={agregarRetornable} />
            ) : modoEscaneo === "inteligente" ? (
              <EscaneoInteligente
                catalogoPT={catalogoPT}
                onCompletado={(pend) => { setPendiente(pend); setFlashOk(true); setTimeout(() => setFlashOk(false), 380); }}
              />
            ) : modoEscaneo === "camara" ? (
              <>
                <EscanerCamara onDetectado={procesarCodigoBarras} flashOk={flashOk} />

                <button
                  onClick={simularEscaneoCamara}
                  className="w-full bg-[#1B2119] border border-[#2A332C] text-[#8A9389] font-medium py-2.5 rounded-xl flex items-center justify-center gap-2 active:scale-[0.98] transition-transform text-sm"
                >
                  <Scan size={16} /> Simular escaneo (sin cámara)
                </button>

                <div className="text-center text-[11px] text-[#6E776A]">— o ingresa el código manualmente —</div>

                <div className="flex gap-2">
                  <input
                    type="text" inputMode="numeric" pattern="[0-9]*"
                    value={inputManual}
                    onChange={(e) => setInputManual(e.target.value)}
                    placeholder="126823630125"
                    style={{ color: "#EDEAE2" }}
                    className="flex-1 mono bg-[#1B2119] border border-[#2A332C] rounded-lg px-3 py-2.5 text-sm placeholder:text-[#4A524A] focus:outline-none focus:border-[#E2231A]"
                  />
                  <button onClick={escanearManualCodigo} style={{ color: "#EDEAE2" }} className="bg-[#2A332C] px-4 rounded-lg text-sm font-medium active:scale-[0.97] transition-transform">
                    Cargar
                  </button>
                </div>

                {ultimoError && (
                  <div className="flex items-start gap-2 bg-[#2A1818] border border-[#5A2A2A] rounded-lg p-3 text-sm text-[#E8A8A8]">
                    <XCircle size={16} className="mt-0.5 shrink-0" /> {ultimoError}
                  </div>
                )}

                {escaneos[0] && (
                  <div className="bg-[#161D14] border border-[#2A332C] rounded-xl p-4">
                    <div className="text-[11px] text-[#8A9389] mb-2 tracking-wide">ÚLTIMO REGISTRO</div>
                    <EscaneoDetalle e={escaneos[0]} catalogo={catalogoActivo} />
                  </div>
                )}
              </>
            ) : (
              <FormularioPTManual submodo={submodoPT} catalogoPT={catalogoPT} onAgregar={agregarManualPT} />
            )}
          </div>
        )}

        {vista === "revision" && (
          <div className="space-y-3">
            {escaneos.length === 0 && (
              <div className="text-center py-16 text-[#6E776A] text-sm">
                Aún no hay registros en esta sesión.
                <br />Ve a la pestaña Escanear para empezar.
              </div>
            )}
            {escaneos.map((e) => (
              <div key={e.id} className="bg-[#161D14] border border-[#2A332C] rounded-xl p-3.5 flex items-start justify-between gap-3">
                <EscaneoDetalle e={e} compact catalogo={catalogoActivo} />
                <button onClick={() => eliminarEscaneo(e.id)} className="text-[#6E776A] hover:text-[#E8A8A8] shrink-0 mt-0.5">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {escaneos.length > 0 && (
              <button
                onClick={() => { setUltimoError(null); setMostrarSync(true); }}
                className="w-full bg-[#161D14] border border-[#E2231A] text-[#E2231A] font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 mt-2"
              >
                <CloudUpload size={18} /> Terminar conteo y sincronizar
              </button>
            )}
          </div>
        )}

        {vista === "comparacion" && (
          <div className="space-y-3">
            <div className="text-xs text-[#8A9389] mb-1">
              {esTPM
                ? "Sumando todos los lotes/fechas por SKU y comparando contra el stock teórico"
                : "Comparando contra la base de datos / stock SAP"}
            </div>
            {comparacion.map((c) => (
              <ComparacionFila key={c.sku} c={c} esTPM={esTPM} />
            ))}
            <div className="pt-2 grid grid-cols-3 gap-2 text-center">
              <Resumen label="Coinciden" value={comparacion.filter((c) => c.tipo === "ok").length} color="#9FD3A6" />
              <Resumen label="Faltantes" value={comparacion.filter((c) => c.tipo === "faltante").length} color="#E8A8A8" />
              <Resumen label="Sobrantes" value={comparacion.filter((c) => c.tipo === "sobrante").length} color="#F2C879" />
            </div>
          </div>
        )}
      </main>

      {pendiente && (
        <ModalCantidadPT
          etiqueta={pendiente}
          catalogoPT={catalogoPT}
          onCancelar={() => setPendiente(null)}
          onConfirmar={(datos) => { confirmarYAgregar(pendiente, datos); setPendiente(null); }}
        />
      )}

      {mostrarUbicacionSesion && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#161D14] border border-[#2A332C] rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div className="text-[11px] text-[#8A9389] tracking-wide">UBICACIÓN DE LA SESIÓN</div>
              <button onClick={() => setMostrarUbicacionSesion(false)} className="text-[#6E776A] hover:text-[#EDEAE2]">
                <X size={20} />
              </button>
            </div>
            <SelectorUbicacion
              ubicacion={ubicacionSesion}
              setUbicacion={setUbicacionSesion}
              ubicacionLibre={ubicacionSesionLibre}
              setUbicacionLibre={setUbicacionSesionLibre}
            />
            <button
              onClick={() => setMostrarUbicacionSesion(false)}
              disabled={ubicacionSesion === "Otros" && !ubicacionSesionLibre.trim()}
              className="w-full bg-[#E2231A] text-white font-bold py-3.5 rounded-xl disabled:opacity-40"
            >
              Confirmar
            </button>
          </div>
        </div>
      )}

      {mostrarSync && (
        <ModalSincronizar
          totalRegistros={escaneos.length}
          sincronizando={sincronizando}
          error={ultimoError}
          onCancelar={() => { setMostrarSync(false); setUltimoError(null); }}
          onConfirmar={async (datos) => {
            setSincronizando(true);
            try {
              // 1. Crear la sesión
              const sesion = await insertarYDevolver("sesiones", {
                numero_empleado: datos.numEmpleado,
                modulo,
                submodo: submodoPT,
                familia: familiaId,
                ubicacion: ubicacionSesion === "Otros" ? ubicacionSesionLibre : ubicacionSesion,
              });
              if (!sesion) throw new Error("No se pudo crear la sesión.");

              // 2. Insertar todos los registros capturados en esta sesión
              const filas = escaneos.map((e) => ({
                sesion_id: sesion.id,
                sku: e.productoId,
                nombre: e.nombre || catalogoPorSkuReal[e.productoId]?.nombre || "",
                cantidad: e.cantidad,
                tarimas_completas: e.tarimasCompletas ?? null,
                restos: e.restos ?? null,
                factor: e.factor ?? null,
                estado: e.estado ?? null,
                fecha_caducidad: e.agrupadorCaducidad ?? null,
                orden_produccion: e.ordenProduccion ?? null,
                es_implicito: e.esImplicito || false,
                de_sku: e.deSku ?? null,
                es_manual: e.esManual || false,
                ubicacion: e.ubicacion,
              }));

              if (filas.length > 0) {
                const { error: errorRegistros } = await supabase.from("registros").insert(filas);
                if (errorRegistros) throw errorRegistros;
              }

              // 3. Marcar la sesión como sincronizada
              await supabase
                .from("sesiones")
                .update({ sincronizada_en: new Date().toISOString() })
                .eq("id", sesion.id);

              setSesionId(sesion.id);
              setSincronizado(datos);
              setMostrarSync(false);
              if (liveRegionRef.current) {
                liveRegionRef.current.textContent = `Sincronizado por ${datos.nombre}`;
              }
            } catch (err) {
              console.error("Error al sincronizar:", err);
              const detalle = err?.message || err?.error_description || err?.hint || err?.details || JSON.stringify(err);
              setUltimoError(`No se pudo sincronizar: ${detalle}`);
            } finally {
              setSincronizando(false);
            }
          }}
        />
      )}

      {sincronizado && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#161D14] border border-[#2A332C] rounded-2xl w-full max-w-sm p-6 text-center space-y-3">
            <div className="w-14 h-14 rounded-full bg-[#15201A] flex items-center justify-center mx-auto">
              <CheckCircle2 size={28} className="text-[#9FD3A6]" />
            </div>
            <div className="font-bold text-lg text-[#EDEAE2]">Sincronizado</div>
            <div className="text-sm text-[#8A9389]">
              {escaneos.length} registros enviados por<br />
              <span className="text-[#EDEAE2] font-semibold">{sincronizado.nombre}</span>
            </div>
            <button
              onClick={reiniciarSesion}
              className="w-full bg-[#E2231A] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 mt-2"
            >
              <LogOut size={16} /> Nueva sesión
            </button>
          </div>
        </div>
      )}

      <div ref={liveRegionRef} className="sr-only" role="status" aria-live="polite" />
    </div>
  );
}

function EscaneoDetalle({ e, compact, catalogo }) {
  const dias = e.agrupadorCaducidad ? diasParaCaducar(e.agrupadorCaducidad) : null;
  const venceProto = dias !== null && dias <= 30;
  const nombre = e.nombre || catalogo?.[e.productoId]?.nombre || (e.unidad === "piezas" ? "No catalogado" : "Producto no catalogado");
  return (
    <div className={compact ? "flex-1" : ""}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono text-sm font-bold text-[#E2231A]">{e.productoId}</span>
        <ChevronRight size={12} className="text-[#4A524A]" />
        <span className="text-sm text-[#EDEAE2]">{nombre}</span>
        {e.esManual && <span className="text-[9px] bg-[#2A2418] text-[#F2C879] px-1.5 py-0.5 rounded-full tracking-wide">MANUAL</span>}
        {e.esImplicito && <span className="text-[9px] bg-[#15201A] text-[#9FD3A6] px-1.5 py-0.5 rounded-full tracking-wide">AUTO · de {e.deSku}</span>}
        {e.estado && <span className="text-[9px] bg-[#1B2119] text-[#C9CFC5] px-1.5 py-0.5 rounded-full tracking-wide">{e.estado}</span>}
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className="mono text-base font-bold text-[#9FD3A6]">{Math.round(e.cantidad)}</span>
        <span className="text-xs text-[#8A9389]">{e.unidad === "tarimas" ? "tarimas" : e.unidad === "piezas" ? "piezas" : "cajas"}</span>
        {e.unidad === "tarimas" && e.cajasXTarima && (
          <span className="mono text-[11px] text-[#6E776A]">
            (× {e.cajasXTarima} = <span className="text-[#9FD3A6] font-bold">{e.cantidad * e.cajasXTarima} cajas</span>)
          </span>
        )}
        {e.tarimasCompletas != null && e.factor != null && (
          <span className="mono text-[11px] text-[#6E776A]">
            ({e.tarimasCompletas} × {e.factor}{e.restos ? ` + ${e.restos}` : ""})
          </span>
        )}
        {e.ubicacion && <span className="flex items-center gap-1 text-[11px] text-[#8A9389] ml-1"><MapPin size={11} /> {e.ubicacion}</span>}
      </div>
      {e.agrupadorCaducidad ? (
        <div className={`mt-2 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${venceProto ? "bg-[#3A2A18] text-[#F2C879]" : "bg-[#1B2119] text-[#8A9389]"}`}>
          {venceProto && <AlertTriangle size={10} />}
          Caduca {formatFecha(e.agrupadorCaducidad)} · {dias} días
        </div>
      ) : !compact && e.unidad !== "piezas" ? (
        <div className="mt-2 text-[10px] text-[#6E776A]">Sin fecha (conteo físico vs. teórico)</div>
      ) : null}
    </div>
  );
}

function ComparacionFila({ c, esTPM }) {
  const config = {
    ok: { icon: CheckCircle2, color: "#9FD3A6", bg: "#15201A", label: "Coincide" },
    faltante: { icon: XCircle, color: "#E8A8A8", bg: "#241616", label: `Faltan ${Math.abs(c.diferencia)}` },
    sobrante: { icon: AlertTriangle, color: "#F2C879", bg: "#241F14", label: `Sobran ${c.diferencia}` },
    no_catalogado: { icon: AlertTriangle, color: "#8A9389", bg: "#1B2119", label: "Sin base" },
  }[c.tipo];
  const Icon = config.icon;
  return (
    <div className="rounded-xl border border-[#2A332C] p-3.5" style={{ backgroundColor: config.bg }}>
      <div className="flex items-center gap-3">
        <Icon size={20} style={{ color: config.color }} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: "#EDEAE2" }}>{c.nombre}</div>
          <div className="mono text-[11px] mt-0.5" style={{ color: "#8A9389" }}>
            SKU {c.sku} · Stock: {c.stockSap} · Contado: {c.escaneado}
          </div>
        </div>
        <div className="text-xs font-bold shrink-0" style={{ color: config.color }}>{config.label}</div>
      </div>
      {esTPM && c.lotes.length > 1 && (
        <div className="mt-2.5 pt-2.5 border-t border-[#2A332C]/60 space-y-1">
          <div className="text-[10px] tracking-wide mb-1" style={{ color: "#6E776A" }}>{c.lotes.length} LOTES</div>
          {c.lotes.map((l, i) => (
            <div key={i} className="flex justify-between text-[11px] mono" style={{ color: "#8A9389" }}>
              <span>{formatFecha(l.fecha)}</span>
              <span style={{ color: "#C9CFC5" }}>{Math.round(l.cantidad)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Resumen({ label, value, color }) {
  return (
    <div className="bg-[#161D14] border border-[#2A332C] rounded-xl py-3">
      <div className="text-2xl font-bold mono" style={{ color }}>{value}</div>
      <div className="text-[10px] text-[#8A9389] mt-0.5">{label}</div>
    </div>
  );
}
