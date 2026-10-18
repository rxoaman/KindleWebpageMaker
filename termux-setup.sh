#!/data/data/com.termux/files/usr/bin/bash

echo "======================================================"
echo "📚 KindleWebpageMaker — Termux Android Setup"
echo "======================================================"

# 1. Update and install prerequisites
echo "--> Updating Termux packages..."
pkg update -y

echo "--> Installing Node.js LTS and Git..."
pkg install -y nodejs-lts git

# 2. Setup storage access (optional, allows accessing Downloads/PDFs)
if [ ! -d "$HOME/storage" ]; then
  echo "--> Setting up Termux storage access..."
  termux-setup-storage
fi

# 3. Install project dependencies
echo "--> Installing project dependencies..."
npm install
npm run install:all

# 4. Build frontend for production
echo "--> Building frontend UI..."
npm run build

echo "======================================================"
echo "✅ Setup complete!"
echo "To start KindleWebpageMaker on your phone, run:"
echo "   ./termux-start.sh"
echo "======================================================"
