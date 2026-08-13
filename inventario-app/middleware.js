// =============================================================================
// CANDADO DE ACCESO — Basic Auth a nivel de Vercel (Routing Middleware).
//
// Se ejecuta ANTES de servir la página, así que alguien sin la contraseña
// nunca llega a descargar el HTML/JS de la app — solo ve el cuadro de
// usuario/contraseña nativo del navegador.
//
// Esto es un candado de "no cualquiera puede entrar por accidente al link",
// NO reemplaza al PIN de supervisor (que sigue protegiendo acciones dentro
// de la app) ni resuelve por sí solo el tema de la llave pública de Supabase
// (ver conversación con Claude sobre RLS). Es una capa adicional, simple y
// gratuita.
//
// CONFIGURACIÓN REQUERIDA en Vercel (Project Settings → Environment Variables):
//   BASIC_AUTH_USER = planta            (o el usuario que prefieras)
//   BASIC_AUTH_PASSWORD = <una contraseña que le compartas al personal>
//
// Después de agregar las variables de entorno, hay que volver a desplegar
// (un simple redeploy basta, no hace falta cambiar código) para que tomen
// efecto.
// =============================================================================

import { next } from "@vercel/edge";

export const config = {
  // Protege la carga de la página principal. Los archivos estáticos ya
  // generados (JS/CSS con nombre con hash) no quedan cubiertos aparte,
  // pero sin poder cargar la página principal nadie conoce esas rutas.
  matcher: "/",
};

export default function middleware(request) {
  const authHeader = request.headers.get("authorization");

  if (authHeader) {
    const basicAuth = authHeader.split(" ")[1];
    const [user, password] = atob(basicAuth).split(":");
    if (user === process.env.BASIC_AUTH_USER && password === process.env.BASIC_AUTH_PASSWORD) {
      return next();
    }
  }

  return new Response("Acceso restringido — Inventario Digital Coatepec", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Inventario Digital Coatepec"',
    },
  });
}
