const { chromium } = require("playwright");

(async () => {
  const codigo = process.argv[2];
  const pass = process.argv[3];

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // 1. LOGIN
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

  console.log("Haciendo click en 'Ingresar'...");
  await page.getByRole("button", { name: "Ingresar" }).click();

  // Esperamos a que cargue el Home
  await page.waitForURL("**/home", { timeout: 30000 });
  console.log("Login OK, estamos en HOME.");

  // 2. IR A INFORMACIÓN ACADÉMICA → CURSOS MATRICULADOS
  console.log("Abriendo menú Información Académica...");
  await page.getByText("Información Académica", { exact: true }).click();

  console.log("Entrando a Cursos Matriculados...");
  await page.getByText("Cursos Matriculados", { exact: true }).click();

  await page.waitForURL("**/informacion-academica/cursos", { timeout: 30000 });
  await page.waitForTimeout(2000);

  // 3. CERRAR EL POPUP DEL CUESTIONARIO (SI APARECE)
  console.log("Revisando si apareció el cuestionario...");

  try {
    // Buscamos el texto del botón "Resolver Cuestionario (Click Aquí)"
    const cuestionario = page.getByText("Resolver Cuestionario", { exact: false });

    if (await cuestionario.count()) {
      console.log("Cuestionario detectado, intentando cerrar...");

      // Click fuera del recuadro (esquina superior izquierda de la pantalla)
      await page.mouse.click(10, 10);

      // Por si acaso, enviamos también la tecla Escape
      await page.keyboard.press("Escape");

      await page.waitForTimeout(1000);
      console.log("Intento de cierre de cuestionario realizado.");
    } else {
      console.log("No apareció el cuestionario.");
    }
  } catch (e) {
    console.log("Error al intentar manejar el cuestionario, seguimos igual.");
  }


  // 4. CLICK EN IMPRIMIR NOTAS
  console.log("Buscando botón 'Imprimir Notas'...");
  await page.getByRole("button", { name: "Imprimir Notas" }).click();

  console.log("Se debería abrir el PDF de notas.");
  // Espera para que veas el PDF abierto
  await page.waitForTimeout(10000);

  console.log("Flujo completo terminado. :)");
  // Si quieres que cierre al final, descomenta:
  // await browser.close();
})();
