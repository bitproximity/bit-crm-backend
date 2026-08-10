const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const REGION = process.env.AWS_SES_REGION || process.env.AWS_REGION;
const SENDER = process.env.SES_SENDER_EMAIL || 'no-reply@bitproximity.com';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !REGION) {
      throw new Error(
        'Faltan credenciales de AWS SES: definí AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY y AWS_SES_REGION (o AWS_REGION) en las variables del backend.'
      );
    }
    client = new SESClient({
      region: REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

// Envía un correo transaccional simple vía SES. No lanza si falla (best-effort) —
// las notificaciones nunca deben tumbar la acción principal (ej. crear un comentario).
// Devuelve { ok: true } o { ok: false, error: '<motivo real de AWS>' }.
async function sendEmail({ to, subject, html, text }) {
  try {
    const command = new SendEmailCommand({
      Source: `Bit Proximity <${SENDER}>`,
      Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
        },
      },
    });
    await getClient().send(command);
    return { ok: true };
  } catch (err) {
    console.error('Error enviando correo vía SES:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail };
