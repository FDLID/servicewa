FROM node:18-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    curl \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    xauth \
    xvfb \
    chromium \
    chromium-sandbox \
    && rm -rf /var/lib/apt/lists/*

# Find chromium path
RUN echo "Chromium path:" && which chromium || which chromium-browser

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev --ignore-scripts

# Copy application files
COPY . .

# Create sessions directory
RUN mkdir -p /app/sessions && chmod 777 /app/sessions

# Environment variables for Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

# Expose port
EXPOSE 3001

CMD ["node", "server.js"]
