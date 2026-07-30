# Inventario Digital · Planta Coatepec

App de inventario para iPad/celular, conectada a Supabase.

## Estructura del proyecto

```
inventario-app/
├── src/
│   ├── InventarioApp.jsx   ← toda la app (UI + lógica + conexión a Supabase)
│   ├── main.jsx            ← punto de entrada de React
│   └── index.css           ← estilos base (Tailwind)
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── vercel.json
├── .env                    ← credenciales de Supabase (NO subir a git público)
└── .env.example            ← plantilla sin valores reales
```

## Cómo probarlo en tu computadora antes de subirlo

Necesitas tener [Node.js](https://nodejs.org) instalado (versión 18 o más reciente).

```bash
cd inventario-app
npm install
npm run dev
```

Esto abre la app en `http://localhost:5173` — pruébala ahí primero.

## Cómo desplegarlo en Vercel (recomendado)

### Opción A — Sin usar terminal, arrastrando la carpeta (más simple)

1. Ve a **vercel.com** y crea una cuenta gratis (puedes usar tu cuenta de GitHub o Google).
2. Click en **"Add New" → "Project"**.
3. Busca la opción de subir una carpeta directamente (o arrástrala a la página).
4. Sube la carpeta `inventario-app` completa.
5. Antes de darle "Deploy", busca la sección **"Environment Variables"** y agrega:
   - `VITE_SUPABASE_URL` → `https://mreaudiufaqpxcaqdxcy.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` → `sb_publishable_h2uPyAzmaIFfoe90VCgFBw_aJLMCEBO`
6. Click en **Deploy**. En 1-2 minutos tendrás una URL como `inventario-coatepec.vercel.app`.

### Opción B — Con GitHub (recomendado si vas a seguir actualizando el código)

1. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
2. En Vercel, click en **"Add New" → "Project"** y conecta ese repositorio.
3. Vercel detecta automáticamente que es un proyecto Vite.
4. Agrega las mismas **Environment Variables** del paso anterior.
5. Click en **Deploy**.
6. Cada vez que subas cambios nuevos al repositorio, Vercel actualiza la app automáticamente.

## Cómo instalarlo en un iPad como si fuera una app

1. Abre la URL de Vercel en Safari del iPad.
2. Toca el botón de compartir (el cuadrado con la flecha hacia arriba).
3. Selecciona **"Añadir a pantalla de inicio"**.
4. Aparecerá un ícono en la pantalla de inicio del iPad — al tocarlo, abre a pantalla completa sin barra de navegador, como una app normal.

Repite este paso en cada iPad/celular que vaya a usarse para capturar inventario.

## Seguridad de las credenciales

La clave en `.env` (`VITE_SUPABASE_ANON_KEY`) es la clave **pública** de Supabase — está diseñada para vivir en código de cliente (navegador/app), protegida por las políticas de Row Level Security que ya están activas en las tablas. No es necesario ni recomendable usar la clave secreta (`sb_secret_...`) en este proyecto.

## Escaneo de código de barras con la cámara

La app usa la cámara real del dispositivo (vía `@zxing/library`) para leer el código de barras de las etiquetas de producción.

- **HTTPS es obligatorio**: los navegadores solo permiten acceso a la cámara en sitios servidos por HTTPS (Vercel ya lo hace automáticamente) o en `localhost` durante desarrollo. No funcionará si se abre el `index.html` directo desde el explorador de archivos.
- **Primera vez**: el navegador pedirá permiso de cámara — hay que aceptarlo. Si se rechaza por error, hay que ir a los ajustes del sitio en el navegador (ícono de candado junto a la URL) y habilitar la cámara manualmente, luego recargar.
- **Cámara trasera por defecto**: la app pide la cámara trasera (`facingMode: environment`), la más práctica para escanear etiquetas físicas.
- Si el dispositivo no tiene cámara o el usuario prefiere no usarla, sigue disponible el campo de código manual y el botón de "Simular escaneo" para pruebas.

