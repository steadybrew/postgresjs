export const bounded = (promise, label, ms = 3000) => {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(reject, ms, new Error(label + ' hung')) })
  ]).finally(() => clearTimeout(timer))
}

export const quiet = (promise, failed, ms = 1000) => bounded(promise, 'cleanup', ms).catch(error => {
  if (!failed)
    throw error
})
