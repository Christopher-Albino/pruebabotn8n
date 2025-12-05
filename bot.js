// bot.js
// Bot de Telegram para leer cursos y notas de INTRALU

const { Telegraf } = require("telegraf");
const { chromium } = require("playwright");

// 🔹 Token desde variables de entorno (Railway / .env)
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ Falta configurar BOT_TOKEN (variable de entorno).");
  process.exit(1);
}

console.log("Iniciando script...");
const bot = new Telegraf(BOT_TOKEN);

// --------- ESTADOS EN MEMORIA ---------

// credenciales[chatId] = { codigo, password }
const credenciales = {};
// estadosLogin[chatId] = { paso, tempCodigo, tempPassword }
const estadosLogin = {};
// cursosPorChat[chatId] = [ { nombre, codcur, seccion, codper }, ... ]
const cursosPorChat = {};
// sesiones[chatId] = { browser, page }
const sesiones = {};

// 🔍 Logger global
bot.use((ctx, next) => {
  const txt = ctx.message?.text || "";
  console.log("📩 Update:", ctx.updateType, JSON.stringify(txt));
  return next();
});

// ------------ FUNCIONES AUXILIARES ------------

// Cerrar el modal de CUESTIONARIO si aparece
async function cerrarModalCuestionario(page) {
  try {
    const dialog = page
      .locator('div[role="dialog"]')
      .filter({ hasText: "CUESTIONARIO" });

    if (await dialog.count()) {
      console.log("Cuestionario detectado, cerrando...");
      // click fuera del recuadro + Escape
      await page.mouse.click(10, 10);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1000);
    } else {
      console.log("No apareció el cuestionario.");
    }
  } catch (e) {
    console.log("No se pudo manejar el cuestionario (no pasa nada):", e.message);
  }
}

// Ir siempre a la página de Cursos Matriculados
async function irACursosMatriculados(page) {
  console.log("Navegando a Cursos Matriculados...");
  await page.goto(
    "https://alumnos.uni.edu.pe/informacion-academica/cursos",
    { waitUntil: "networkidle", timeout: 60000 }
  );
}

// Hace login y deja la página en "Cursos Matriculados"
async function loginYIrACursos(codigo, pass) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("Abriendo INTRALU...");
  await page.goto("https://alumnos.uni.edu.pe/login", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForTimeout(3000);

  console.log("Llenando código...");
  await page.getByLabel("Código Uni").fill(codigo);

  console.log("Llenando contraseña...");
  const passInput = page.locator('input[type="password"]');
  await passInput.waitFor({ timeout: 10000 });
  await passInput.fill(pass);

  console.log("Ingresando...");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL("**/home", { timeout: 30000 });

  console.log("En HOME. Yendo a Cursos Matriculados...");
  await irACursosMatriculados(page);
  await cerrarModalCuestionario(page);

  return { browser, page };
}

// Devuelve una sesión (browser + page) ya logueada para ese chat.
// Si no existe o la página se cerró, hace login.
async function obtenerSesion(chatId, codigo, pass) {
  let ses = sesiones[chatId];

  // Reutilizar si el browser y la page siguen vivos
  if (ses && ses.browser && ses.page && !ses.page.isClosed()) {
    console.log("♻️ Reutilizando sesión existente para chat", chatId);
    return ses;
  }

  console.log("🚪 No hay sesión o se cerró, haciendo login desde cero para chat", chatId);
  const { browser, page } = await loginYIrACursos(codigo, pass);
  sesiones[chatId] = { browser, page };
  return sesiones[chatId];
}

// 1) Obtener lista de cursos desde la tabla de Cursos Matriculados
async function obtenerCursosMatriculados(page) {
  await irACursosMatriculados(page);
  await cerrarModalCuestionario(page);

  console.log("Buscando tabla de cursos matriculados...");

  const cursos = await page.evaluate(() => {
    const resultado = [];
    // Tomamos todas las filas de todas las tablas y filtramos por las que tienen btn-ver-curso
    const filas = Array.from(document.querySelectorAll("table tbody tr"));

    filas.forEach((fila) => {
      const btn = fila.querySelector("button.btn-ver-curso");
      if (!btn) return; // ignorar filas sin botón de “ver curso”

      const celdas = fila.querySelectorAll("td");
      if (celdas.length < 2) return;

      const cod = (celdas[0]?.innerText || "").trim(); // BEG01-U
      const nom = (celdas[1]?.innerText || "").trim(); // ECONOMIA GENERAL

      if (!cod || !nom) return;

      const codcur = btn.getAttribute("data-codcur") || "";
      const seccion = btn.getAttribute("data-seccion") || "";
      const codper = btn.getAttribute("data-codper") || "";

      // Nombre visible sin "(Obligatorio)"
      const nombreVisible = `${cod} - ${nom}`;

      resultado.push({
        nombre: nombreVisible,
        codcur,
        seccion,
        codper,
      });
    });

    return resultado;
  });

  console.log("Cursos detectados (filtrados):", cursos);
  return cursos;
}

// Función de alto nivel usada por /notas
// Función de alto nivel usada por /notas
async function obtenerCursos(chatId, codigo, pass) {
  let ses = await obtenerSesion(chatId, codigo, pass);
  let { page, browser } = ses;

  // 🔹 Primer intento con la sesión actual
  let cursos = await obtenerCursosMatriculados(page);

  // Si no hay cursos o nos mandaron de vuelta al login, probamos reloguear
  if (!cursos.length || page.url().includes("/login")) {
    console.log("⚠️ No se encontraron cursos o la sesión parece expirada. Relogueando...");

    try {
      await browser.close();
    } catch (e) {
      console.log("Error cerrando browser viejo:", e.message);
    }

    delete sesiones[chatId];

    // Nuevo login desde cero
    const sesNueva = await loginYIrACursos(codigo, pass);
    sesiones[chatId] = sesNueva;
    page = sesNueva.page;
    browser = sesNueva.browser;

    // Segundo intento ahora con sesión fresca
    cursos = await obtenerCursosMatriculados(page);
  }

  cursosPorChat[chatId] = cursos;
  return cursos;
}


// 2) Obtener detalle de notas de un curso específico usando URL directa
async function obtenerDetalleCurso(chatId, codigo, pass, metaCurso) {
  const { page } = await obtenerSesion(chatId, codigo, pass);
  const { codcur, seccion, codper } = metaCurso;

  console.log("Navegando directo a la página del curso con:", {
    codcur,
    seccion,
    codper,
  });

  const urlCurso = `https://alumnos.uni.edu.pe/informacion-academica/cursos/${codper}/${codcur}/${seccion}`;
  console.log("URL de curso:", urlCurso);

  await page.goto(urlCurso, { waitUntil: "networkidle" }).catch((e) => {
    console.log("Error en goto curso:", e.message);
  });

  // Por si carga parcial
  await page.waitForTimeout(2000);

  console.log("Esperando tabla de notas...");
  try {
    await page.waitForSelector("table", { timeout: 15000 });
  } catch (e) {
    console.log("No apareció ninguna tabla:", e.message);
  }

  console.log("Página de detalle cargada. Buscando tabla de notas...");

  const notas = await page.evaluate(() => {
    const tablas = Array.from(document.querySelectorAll("table"));
    if (!tablas.length) return [];

    // Buscar tabla cuya cabecera tenga EXAMEN y NOTA
    const tablaNotas = tablas.find((t) => {
      const theadText = (t.querySelector("thead")?.innerText || "").toUpperCase();
      return theadText.includes("EXAMEN") && theadText.includes("NOTA");
    });

    if (!tablaNotas) return [];

    const filas = Array.from(tablaNotas.querySelectorAll("tbody tr"));

    const resultado = filas.map((f) => {
      const tds = f.querySelectorAll("td");
      if (!tds.length) return null;

      const evaluacion = (tds[0].innerText || "").trim();        // PRACTICA 1 (N1)
      const nota = tds[1] ? (tds[1].innerText || "").trim() : ""; // 15
      const fecha = tds[3]?.innerText?.trim() || "";              // 15/10/2025

      return { evaluacion, nota, fecha };
    });

    return resultado.filter(Boolean);
  });

  console.log("Notas obtenidas:", notas);
  return notas;
}

// ----------------- COMANDOS -----------------

bot.start((ctx) => {
  console.log("➡️ Handler /start");
  ctx.reply(
    "Hola, soy tu bot de notas de la UNI 😎\n\n" +
      "1️⃣ Usa /login para registrar tu código UNI y contraseña DIRCE.\n" +
      "2️⃣ Usa /notas para ver la lista de cursos.\n" +
      "3️⃣ Responde con el *número* del curso para ver sus notas.",
    { parse_mode: "Markdown" }
  );
});

// /login → flujo para guardar credenciales con confirmación
bot.command("login", (ctx) => {
  console.log("➡️ Handler /login");
  const chatId = ctx.chat.id;
  estadosLogin[chatId] = { paso: "codigo" };
  ctx.reply("Escribe tu *Código UNI*:", {
    parse_mode: "Markdown",
  });
});

// /notas → obtiene lista de cursos y la muestra enumerada
bot.command("notas", async (ctx) => {
  const chatId = ctx.chat.id;
  console.log("➡️ Handler /notas para chat", chatId);

  const creds = credenciales[chatId];
  if (!creds) {
    console.log("⚠️ /notas sin credenciales");
    return ctx.reply(
      "Primero usa /login para registrar tu código UNI y contraseña DIRCE."
    );
  }

  await ctx.reply(
    "⏳ Conectándome a INTRALU y leyendo tu lista de cursos matriculados..."
  );

  try {
    const cursos = await obtenerCursos(chatId, creds.codigo, creds.password);

    if (!cursos.length) {
      return ctx.reply(
        "No pude detectar cursos en la página. Revisa manualmente en INTRALU."
      );
    }

    cursosPorChat[chatId] = cursos;

    let msg = "📚 *Tus cursos detectados*\n\n";
    cursos.forEach((c, i) => {
      msg += `${i + 1}. ${c.nombre}\n`;
    });
    msg += "\nResponde con el *número* del curso para ver sus notas.\nEjemplo: `1`";

    await ctx.replyWithMarkdown(msg);
    console.log("✅ /notas completado para chat", chatId);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Error obteniendo tus cursos: " + e.message);
  }
});

// ------------- MANEJO DE MENSAJES DE TEXTO -------------

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const texto = ctx.message.text.trim();
  const estado = estadosLogin[chatId];

  // 1) Flujo de /login con confirmaciones
  if (estado) {
    console.log(`🧾 Mensaje en flujo /login: "${texto}" (paso=${estado.paso})`);

    // Paso 1: pedir código
    if (estado.paso === "codigo") {
      estado.tempCodigo = texto;
      estado.paso = "confirmar_codigo";
      return ctx.reply(
        `¿Confirmas que tu Código UNI es *${texto}*?\nResponde:\n1. Sí\n2. No`,
        { parse_mode: "Markdown" }
      );
    }

    // Confirmar código
    if (estado.paso === "confirmar_codigo") {
      if (texto === "1") {
        estado.paso = "password";
        return ctx.reply(
          "Ahora escribe tu *contraseña DIRCE*.\n\n⚠️ Este bot no guarda tu contraseña:\n" +
            "solo la usa localmente en tu máquina para iniciar sesión en INTRALU.",
          { parse_mode: "Markdown" }
        );
      } else if (texto === "2") {
        estado.paso = "codigo";
        return ctx.reply("Vuelve a escribir tu *Código UNI*:", {
          parse_mode: "Markdown",
        });
      } else {
        return ctx.reply("Responde 1 para Sí o 2 para No.");
      }
    }

    // Paso 2: pedir contraseña DIRCE
    if (estado.paso === "password") {
      estado.tempPassword = texto;
      estado.paso = "confirmar_password";
      return ctx.reply(
        "¿Confirmas que la *contraseña DIRCE* que escribiste es correcta?\n" +
          "Por seguridad no la mostraré.\n\nResponde:\n1. Sí\n2. No",
        { parse_mode: "Markdown" }
      );
    }

    // Confirmar contraseña
    if (estado.paso === "confirmar_password") {
      if (texto === "1") {
        credenciales[chatId] = {
          codigo: estado.tempCodigo,
          password: estado.tempPassword,
        };
        delete estadosLogin[chatId];
        console.log("✅ Credenciales guardadas para chat:", chatId);
        return ctx.reply(
          "✅ Listo, credenciales guardadas.\nAhora puedes usar /notas para ver tus cursos.",
          { parse_mode: "Markdown" }
        );
      } else if (texto === "2") {
        estado.paso = "password";
        return ctx.reply(
          "Vuelve a escribir tu *contraseña DIRCE*:",
          { parse_mode: "Markdown" }
        );
      } else {
        return ctx.reply("Responde 1 para Sí o 2 para No.");
      }
    }

    // Si por alguna razón cae fuera de estos pasos:
    return;
  }

  // 2) Selección de curso por número
  const cursos = cursosPorChat[chatId];
  if (cursos && /^\d+$/.test(texto)) {
    const idx = parseInt(texto, 10) - 1;
    if (idx < 0 || idx >= cursos.length) {
      return ctx.reply("Número fuera de rango. Vuelve a enviar un número válido.");
    }

    const curso = cursos[idx];
    console.log(`ℹ️ Usuario pidió detalle del curso #${idx + 1}:`, curso);

    const creds = credenciales[chatId];
    if (!creds) {
      return ctx.reply("Primero usa /login para registrar tus credenciales.");
    }

    await ctx.reply(`⏳ Obteniendo notas para: *${curso.nombre}*...`, {
      parse_mode: "Markdown",
    });

    try {
      const notas = await obtenerDetalleCurso(
        chatId,
        creds.codigo,
        creds.password,
        curso
      );

      let msg = `📘 *${curso.nombre}*\n\n`;
      if (!notas.length) {
        msg += "_No encontré filas de notas en la tabla._";
      } else {
        msg += "*Notas detectadas:*\n";
        for (const n of notas) {
          msg += `• ${n.evaluacion}: *${n.nota || "--"}*`;
          if (n.fecha) msg += ` (${n.fecha})`;
          msg += "\n";
        }
      }

      msg +=
        "\nPuedes enviar otro número para ver otro curso o usar /notas para ver la lista de nuevo.";

      return ctx.replyWithMarkdown(msg);
    } catch (e) {
      console.error(e);
      return ctx.reply("❌ Error obteniendo el detalle de notas: " + e.message);
    }
  }

  // 3) Mensajes random fuera de flujo
  // Si quieres puedes responder algo genérico aquí
  // ctx.reply("Usa /login, /notas o envía un número de curso.");
});

// Cerrar navegadores al terminar el proceso (Ctrl+C / stop en Railway)
process.on("SIGINT", async () => {
  console.log("Cerrando sesiones...");
  for (const chatId of Object.keys(sesiones)) {
    try {
      await sesiones[chatId].browser.close();
    } catch {}
  }
  process.exit();
});

// Lanzar bot
bot.launch().then(() => {
  console.log("🤖 Bot de Telegram iniciado ✅");
});
