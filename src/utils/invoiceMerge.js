// Qué cambia en una factura YA sincronizada cuando el origen (Alegra, Stripe) trae datos nuevos.
//
// Hasta ahora el sincronizador solo CREABA facturas: si en Alegra se registraba un pago, se corregía un
// vencimiento o se anulaba una factura, el CRM nunca se enteraba. Pero el CRM también se edita a mano (alguien
// marca «Pagada» un cobro que aún no se registró en Alegra). Por eso la regla es conservadora:
//   · los cobros SOLO suben: nunca se baja lo cobrado ni se pasa una factura de «Pagada» a «Pendiente»
//   · el vencimiento y el total se alinean con el origen (es la fuente de esos datos)
//   · una factura anulada en el origen se cancela solo si en el CRM no tiene cobros
//   · lo que no cuadra (el CRM dice pagada y el origen dice abierta) NO se pisa: se devuelve como diferencia
//     para mostrarla y que alguien decida.
const EPS = 0.01;
const RANK = { pendiente: 0, parcial: 1, pagada: 2 };

const statusFor = (paid, total) => (total > 0 && paid >= total - EPS ? 'pagada' : paid > EPS ? 'parcial' : 'pendiente');

function mergeIncoming(existing, incoming) {
  const patch = {};
  const exPaid = Number(existing.paid_amount || 0);
  const exTotal = Number(existing.total || 0);
  const inPaid = Number(incoming.paid_amount || 0);
  const inTotal = incoming.total == null ? exTotal : Number(incoming.total);
  let paymentDelta = 0;
  let discrepancy = null;
  const info = { crm_status: existing.status, crm_paid: exPaid, origen_paid: inPaid, total: inTotal, currency: existing.currency };

  if (incoming.status === 'cancelada') { // anulada en el origen
    if (existing.status !== 'cancelada') {
      if (exPaid <= EPS) patch.status = 'cancelada';
      else discrepancy = { kind: 'anulada_en_origen_con_cobros_en_crm', ...info };
    }
  } else {
    if (inPaid > exPaid + EPS) { patch.paid_amount = inPaid; paymentDelta = inPaid - exPaid; }
    const paid = patch.paid_amount ?? exPaid;
    if (Math.abs(inTotal - exTotal) > EPS) {
      patch.total = inTotal;
      if (incoming.subtotal != null) patch.subtotal = Number(incoming.subtotal);
      if (incoming.tax != null) patch.tax = Number(incoming.tax);
    }
    const total = patch.total ?? exTotal;
    const wanted = statusFor(paid, total);
    if (existing.status === 'cancelada') {
      if (incoming.status === 'pagada' && wanted === 'pagada') patch.status = 'pagada'; // «cerrada» y cobrada en el origen
    } else if (RANK[wanted] > (RANK[existing.status] ?? 0)) {
      patch.status = wanted;
    }
    if (existing.status === 'pagada' && inPaid < inTotal - EPS) discrepancy = { kind: 'pagada_en_crm_abierta_en_origen', ...info };
    else if (exPaid > inPaid + EPS) discrepancy = { kind: 'cobro_en_crm_no_registrado_en_origen', ...info };
  }

  if (incoming.due_date && incoming.due_date !== existing.due_date) patch.due_date = incoming.due_date;
  return { patch, paymentDelta, discrepancy };
}

module.exports = { mergeIncoming, statusFor, EPS };
