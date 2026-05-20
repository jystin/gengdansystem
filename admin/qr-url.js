function buildQrUrl(text, size = 320) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`
}

window.QrUrl = {
  buildQrUrl
}
