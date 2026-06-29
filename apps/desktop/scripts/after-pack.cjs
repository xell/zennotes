const fs = require('fs')
const path = require('path')

const ORIGINAL = path.resolve(__dirname, '../build/after-pack.js')

module.exports = async function afterPack(context) {
  if (fs.existsSync(ORIGINAL)) {
    const original = require(ORIGINAL)
    if (typeof original === 'function') await original(context)
  }

  if (context.packager.platform.name !== 'mac') return

  const spawnHelper = path.join(
    context.appOutDir,
    'ZenNotes.app/Contents/Resources/node-pty/prebuilds/darwin-arm64/spawn-helper'
  )
  if (fs.existsSync(spawnHelper)) {
    fs.chmodSync(spawnHelper, 0o755)
  }
}
