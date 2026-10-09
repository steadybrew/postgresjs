import net from 'net'
import tls from 'tls'
import b from './bytes.js'
import clampedTimeout from './timeout.js'

export const SSLRequest = b().i32(8).i32(80877103).end(8)

export function tlsConfig(options, raw) {
  const { ssl, sslnegotiation } = options
  const config = {
    socket: raw,
    servername: net.isIP(raw.host) ? undefined : raw.host
  }

  if (sslnegotiation === 'direct')
    config.ALPNProtocols = ['postgresql']

  if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
    config.rejectUnauthorized = false
  else if (typeof ssl === 'object')
    Object.assign(config, ssl)

  return config
}

export function cancelRequest(options, backend) {
  return Promise.resolve()
    .then(() => options.socket ? options.socket(options) : new net.Socket())
    .then(socket => sendCancel(options, backend, socket))
}

function sendCancel(options, { pid, secret }, s) {
  const { ssl, sslnegotiation, host, port } = options
  const request = b().i32(16).i32(80877102).i32(pid).i32(secret).end(16)

  return new Promise((resolve, reject) => {
    let timeout = null
    const watch = x => {
      x.once('error', reject)
      x.on('error', () => undefined)
      x.once('close', () => (clearTimeout(timeout), resolve()))
    }
    const upgrade = () => {
      try {
        const raw = s
        const config = tlsConfig(options, raw)
        raw.removeAllListeners()
        s = tls.connect(config)
        watch(s)
        s.once('secureConnect', () => s.write(request))
      } catch (error) {
        clearTimeout(timeout)
        s.destroy()
        reject(error)
      }
    }
    const start = !ssl
      ? () => s.write(request)
      : sslnegotiation === 'direct'
        ? upgrade
        : () => {
          s.once('data', x => x[0] === 83 || ssl !== 'prefer' ? upgrade() : s.write(request))
          s.write(SSLRequest)
        }

    try {
      watch(s)
      options.connect_timeout && (timeout = clampedTimeout(() => s.destroy(), options.connect_timeout * 1000))

      if (options.socket)
        return start()

      s.once('connect', start)

      if (options.path)
        return s.connect(options.path)

      s.ssl = ssl
      s.connect(port[0], host[0])
      s.host = host[0]
      s.port = port[0]
    } catch (error) {
      clearTimeout(timeout)
      reject(error)
    }
  })
}

