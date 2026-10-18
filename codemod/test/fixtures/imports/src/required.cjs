const postgres = require('postgres')

module.exports = postgres({ fetch_types: false })
