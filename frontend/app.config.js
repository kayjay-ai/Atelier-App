// Build-time additions to app.json (Expo reads app.json, then passes it here).
//
// Android plain-HTTP ("cleartext") traffic is allowed only for the EAS
// `development` and `preview` profiles and for local runs: those talk to a
// laptop on the LAN (http://<LAN-IP>:8787). Store builds (`production`) and any
// other profile use HTTPS only. EAS sets EAS_BUILD_PROFILE during a build.
module.exports = ({ config }) => {
  const profile = process.env.EAS_BUILD_PROFILE
  const allowHttp = !profile || profile === 'development' || profile === 'preview'
  const plugins = (config.plugins ?? []).map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin
    const [name, options = {}] = plugin
    return [name, { ...options, android: { ...(options.android ?? {}), usesCleartextTraffic: allowHttp } }]
  })
  return { ...config, plugins }
}
