FROM node:18-slim

# Install Chrome for Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    unzip \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    fonts-liberation \
    && wget -q -O /usr/local/bin/chrome-headless-shell https://storage.googleapis.com/chrome-for-testing-public/116.0.5845.96/linux64/chrome-headless-shell-linux64.zip \
    && unzip /usr/local/bin/chrome-headless-shell -d /usr/local/bin/ \
    && rm /usr/local/bin/chrome-headless-shell.zip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path
ENV CHROME_PATH=/usr/local/bin/chrome-headless-shell-linux64/chrome-headless-shell

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# Create sessions directory
RUN mkdir -p sessions && chmod 755 sessions

EXPOSE 3001

CMD ["npm", "start"]
