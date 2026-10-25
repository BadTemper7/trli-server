import 'dotenv/config'
import http from 'http'
import app from './app.js'
import { connectDB } from './config/db.js'
import { initSocket } from './socket/index.js'

const PORT = Number(process.env.PORT || 5000)

function validateEnvironment() {
  const required = ['JWT_SECRET', 'CLIENT_URL', 'ADMIN_URL', 'MONGODB_URI']
  const missing = required.filter((key) => !process.env[key])

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
}

function startServer() {
  validateEnvironment()

  return connectDB()
    .then(() => {
      const server = http.createServer(app)
      initSocket(server)

      server.listen(PORT, () => {
        console.log(`Trans Roadway API listening on port ${PORT}`)
      })

      server.on('error', (error) => {
        console.error('HTTP server error:', error)
      })

      return server
    })
    .catch((error) => {
      console.error('Failed to start Trans Roadway API:', error)
      process.exitCode = 1
      throw error
    })
}

startServer()

export { app, startServer }
