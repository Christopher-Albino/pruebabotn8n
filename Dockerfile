FROM node:20-bullseye

# 1. Crear directorio de trabajo
WORKDIR /app

# 2. Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm install

# 3. Instalar navegadores de Playwright (con dependencias)
RUN npx playwright install --with-deps chromium

# 4. Copiar el resto del código
COPY . .

# 5. Variable de entorno para producción
ENV NODE_ENV=production

# 6. Comando por defecto
CMD ["node", "bot.js"]
