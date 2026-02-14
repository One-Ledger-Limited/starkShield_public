# StarkShield Deployment Guide

## 📋 Pre-Deployment Checklist

Before deploying, ensure you have:
- [ ] Server host/IP: `<your-server-host>`
- [ ] SSH username: `<deploy-user>`
- [ ] SSH key-based login configured
- [ ] Target directory: `/vol2/develop/starkshield` (or your preferred path)
- [ ] Docker and Docker Compose installed on server
- [ ] At least 4GB free disk space
- [ ] Ports 80, 5173, 8080, 6379 available

## 🔧 Option 1: Automated Deployment Script (Recommended)

### Step 1: Copy Project to Server

On your local machine, run:

```bash
# Create a tarball of the project
cd /path/to/starkshield
tar -czf starkshield-deploy.tar.gz \
  --exclude='node_modules' \
  --exclude='target' \
  --exclude='.git' \
  --exclude='build' \
  --exclude='dist' \
  .

# Copy to server using scp (uses your SSH key)
scp starkshield-deploy.tar.gz <deploy-user>@<your-server-host>:/tmp/
```

### Step 2: SSH into Server and Deploy

```bash
# SSH to server
ssh -i ~/.ssh/id_rsa <deploy-user>@<your-server-host>

# Extract and deploy
cd /vol2/develop
sudo mkdir -p starkshield
sudo tar -xzf /tmp/starkshield-deploy.tar.gz -C starkshield/
cd starkshield

# Make scripts executable
sudo chmod +x deploy.sh update.sh backup.sh

# Configure environment
sudo cp .env.example .env
sudo nano .env  # Edit with your actual values

# Run deployment
bash deploy.sh
```

## 🔧 Option 2: Manual Docker Deployment

### Step 1: Prepare Server

```bash
# SSH to server
ssh <deploy-user>@<your-server-host>

# Create directory
sudo mkdir -p /vol2/develop/starkshield
cd /vol2/develop/starkshield

# Install Docker if not present (Ubuntu/Debian)
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker <deploy-user>
fi

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/download/v2.23.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### Step 2: Copy Project Files

From your local machine:

```bash
# Use rsync to copy files (excluding unnecessary directories)
rsync -avz --exclude='node_modules' --exclude='target' --exclude='.git' \
  /path/to/starkshield/ <deploy-user>@<your-server-host>:/vol2/develop/starkshield/

# Ensure your SSH key is trusted on target host
```

### Step 3: Configure Environment

```bash
ssh <deploy-user>@<your-server-host>
cd /vol2/develop/starkshield

# Create environment file
sudo tee .env << EOF
# Server Configuration
SOLVER_ADDR=0.0.0.0:8080

# Database
REDIS_URL=redis://redis:6379

# Starknet Configuration
STARKNET_RPC=https://starknet-sepolia.public.blastapi.io
DARK_POOL_ADDRESS=0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
SOLVER_PRIVATE_KEY=YOUR_PRIVATE_KEY_HERE

# Matching Configuration
MIN_MATCH_AMOUNT_USD=100.0
MAX_SLIPPAGE_BPS=50
MATCH_TIMEOUT_SECONDS=300
BATCH_SIZE=10
POLL_INTERVAL_MS=1000

# API Configuration
MAX_INTENT_SIZE_BYTES=1048576
RATE_LIMIT_RPM=60
CORS_ORIGINS=http://localhost:5173
JWT_SECRET=replace-with-strong-secret
AUTH_USERNAME=admin
AUTH_PASSWORD=replace-with-strong-password

# Frontend Configuration
VITE_STARKNET_RPC=https://starknet-sepolia.public.blastapi.io
VITE_DARK_POOL_ADDRESS=0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
# Prefer same-origin (`/api`) via reverse proxy in production.
VITE_SOLVER_API_URL=
EOF
```

⚠️ **IMPORTANT:** Replace `YOUR_PRIVATE_KEY_HERE` with your actual Starknet private key!

### Step 4: Build and Deploy

```bash
cd /vol2/develop/starkshield

# Build and start services
sudo docker-compose -f docker-compose.prod.yml up -d --build

# Check status
sudo docker-compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Verify deployment
bash deploy/scripts/verify-prod.sh

# Roll back if deployment fails
bash deploy/scripts/rollback.sh
```

## 🌐 Accessing the Application

After deployment:

- **Frontend:** `http://<your-server-host>:<frontend-port>`
- **Solver API:** `http://<your-server-host>:<solver-port>`
- **Health Check:** `http://<your-server-host>:<solver-port>/health`

## 🔒 Security Considerations

### 1. Firewall Configuration

```bash
# Allow necessary ports
sudo ufw allow 80/tcp
sudo ufw allow 5173/tcp
sudo ufw allow 8080/tcp
sudo ufw allow 6379/tcp  # Only if Redis needs external access

# Enable firewall
sudo ufw enable
```

### 2. Environment Variables

Never commit `.env` file to git! It contains sensitive information.

### 3. SSL/TLS (Production)

For production with HTTPS:

```bash
# Install certbot
sudo apt-get install certbot

# Generate certificates
sudo certbot certonly --standalone -d your-domain.com

# Copy certificates
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ./nginx/ssl/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem ./nginx/ssl/

# Enable nginx in docker-compose
sudo docker-compose -f docker-compose.prod.yml --profile production up -d
```

## 📊 Monitoring

### View Logs

```bash
# All services
sudo docker-compose -f docker-compose.prod.yml logs -f

# Specific service
sudo docker-compose -f docker-compose.prod.yml logs -f solver
sudo docker-compose -f docker-compose.prod.yml logs -f frontend
sudo docker-compose -f docker-compose.prod.yml logs -f redis
```

### Check Service Status

```bash
sudo docker-compose -f docker-compose.prod.yml ps
sudo docker stats
```

## 🔄 Updates

To update the deployment:

```bash
cd /vol2/develop/starkshield

# Backup first
sudo ./backup.sh

# Update code (copy new files)
# ...

# Rebuild and restart
sudo docker-compose -f docker-compose.prod.yml down
sudo docker-compose -f docker-compose.prod.yml up -d --build
```

## 🛠️ Troubleshooting

### Services Won't Start

```bash
# Check logs
sudo docker-compose -f docker-compose.prod.yml logs

# Check port conflicts
sudo netstat -tulpn | grep -E '80|5173|8080|6379'

# Restart services
sudo docker-compose -f docker-compose.prod.yml restart
```

### Permission Denied

```bash
# Fix permissions
sudo chown -R <deploy-user>:<deploy-user> /vol2/develop/starkshield
sudo chmod +x /vol2/develop/starkshield/*.sh
```

### Out of Disk Space

```bash
# Clean up Docker
sudo docker system prune -a
sudo docker volume prune
```

## 📞 Support

If you encounter issues:

1. Check the logs: `sudo docker-compose logs`
2. Verify environment variables in `.env`
3. Ensure all ports are available
4. Check disk space: `df -h`
5. Contact the StarkShield team

## ✅ Verification Checklist

After deployment, verify:

- [ ] Frontend loads at `http://<your-server-host>:<frontend-port>`
- [ ] Health check returns OK: `http://<your-server-host>:<solver-port>/health`
- [ ] Can connect wallet
- [ ] Can submit test intent
- [ ] Solver is matching intents
- [ ] No errors in logs

## 📝 Notes

- The deployment uses Docker for isolation and easy management
- Redis data is persisted in a Docker volume
- Logs are limited to 100MB per service with 3 rotations
- Services automatically restart on failure
- For production, consider using nginx reverse proxy with SSL
