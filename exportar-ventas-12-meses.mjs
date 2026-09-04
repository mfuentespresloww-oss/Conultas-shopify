import fs from "node:fs";
import ExcelJS from "exceljs";

const STORE = process.env.SHOPIFY_STORE
  ?.replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const TIMEZONE = "America/Mexico_City";
const API_VERSION = "2026-07";
const OUTPUT_DIR = "ventas-data";
const OUTPUT_FILE = `${OUTPUT_DIR}/Ventas_Ultimos_12_Meses.xlsx`;

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Faltan datos en .env");
  process.exit(1);
}

// ======================================================
// PERIODO: MES ACTUAL + 11 MESES ANTERIORES
// ======================================================

function getYearMonthInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);

  return { year, month };
}

function shiftMonth(year, month, offset) {
  const index = year * 12 + (month - 1) + offset;
  const shiftedYear = Math.floor(index / 12);
  const shiftedMonth = (index % 12) + 1;

  return {
    year: shiftedYear,
    month: shiftedMonth,
    key: `${shiftedYear}-${String(shiftedMonth).padStart(2, "0")}`,
  };
}

const nowYM = getYearMonthInTimezone();
const startYM = shiftMonth(nowYM.year, nowYM.month, -11);
const ENDYM = shiftMonth(nowYM.year, nowYM.month, 0);
const DESDE = `${startYM.key}-01`;
const MES_ACTUAL_KEY = ENDYM.key;

function generarMesesPeriodo() {
  const meses = [];

  for (let i = -11; i <= 0; i++) {
    meses.push(shiftMonth(nowYM.year, nowYM.month, i).key);
  }

  return meses;
}

function nombreMes(mesKey) {
  const [year, month] = mesKey.split("-").map(Number);

  const fecha = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));

  const nombre = new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(fecha);

  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}

function getMesKey(fechaISO) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(fechaISO));

  const year = partes.find((p) => p.type === "year")?.value;
  const month = partes.find((p) => p.type === "month")?.value;

  return `${year}-${month}`;
}

function fechaLocal(fechaISO) {
  if (!fechaISO) return "";

  return new Intl.DateTimeFormat("es-MX", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(fechaISO));
}

// ======================================================
// AUTENTICACIÓN
// ======================================================

async function getAccessToken() {
  const response = await fetch(
    `https://${STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("❌ No se pudo obtener access token");
    console.error(data);
    process.exit(1);
  }

  return data.access_token;
}

// ======================================================
// GRAPHQL
// ======================================================

async function graphql(token, query, variables = {}) {
  const response = await fetch(
    `https://${STORE}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const result = await response.json();

  if (result.errors) {
    console.error("❌ Error GraphQL:");
    console.dir(result.errors, { depth: null });
    process.exit(1);
  }

  return result.data;
}

// ======================================================
// PEDIDOS
// ======================================================

async function getOrders(token) {
  const query = `
    query Pedidos12Meses($after: String, $query: String!) {
      orders(
        first: 100
        after: $after
        sortKey: CREATED_AT
        query: $query
      ) {
        nodes {
          id
          name
          createdAt
          updatedAt
          cancelledAt
          displayFinancialStatus
          fullyPaid
          unpaid
          test
          paymentGatewayNames

          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          totalReceivedSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          netPaymentSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }

        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let after = null;
  let orders = [];
  let pagina = 1;

  do {
    console.log(`Consultando página ${pagina}...`);

    const data = await graphql(token, query, {
      after,
      query: `created_at:>=${DESDE} test:false`,
    });

    orders.push(...data.orders.nodes);

    after = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;

    pagina++;
  } while (after);

  return orders;
}

// ======================================================
// UTILIDADES
// ======================================================

function money(order, field) {
  return Number(order[field]?.shopMoney?.amount || 0);
}

function redondear(numero, decimales = 2) {
  return Number(Number(numero || 0).toFixed(decimales));
}

function pct(parte, total) {
  if (!total) return 0;
  return (parte / total) * 100;
}

function normalizarGateway(valor) {
  if (!valor) return "No identificado";

  const texto = String(valor).toLowerCase();

  if (texto.includes("openpay")) return "Openpay";

  if (
    texto.includes("mercado pago checkout pro") ||
    texto.includes("checkout mercado pago")
  ) {
    return "Checkout Mercado Pago";
  }

  if (
    texto.includes("mercado pago tarjetas") ||
    texto.includes("mercado pago tarjeta")
  ) {
    return "Mercado Pago Tarjetas";
  }

  if (texto.includes("paypal")) return "PayPal";

  if (
    texto.includes("aplazo") ||
    texto.includes("compra ahora, paga después") ||
    texto.includes("compra ahora, paga despues")
  ) {
    return "Compra ahora, paga después";
  }

  return String(valor).trim();
}

function gatewaysPedido(order) {
  const gateways = order.paymentGatewayNames || [];

  if (!gateways.length) return "No identificado";

  return gateways.map(normalizarGateway).join(" | ");
}

function clasificarPago(order) {
  const recibido = money(order, "totalReceivedSet");
  const reembolsado = money(order, "totalRefundedSet");
  const neto = money(order, "netPaymentSet");
  const estado = order.displayFinancialStatus || "SIN_ESTADO";

  // PAGADO = el pedido recibió dinero en algún momento.
  // Esto incluye pedidos luego reembolsados, que se separan en detalle.
  if (recibido > 0) {
    if (
      estado === "REFUNDED" ||
      (reembolsado > 0 && neto <= 0)
    ) {
      return "PAGADO_Y_REEMBOLSADO";
    }

    if (estado === "PARTIALLY_PAID") {
      return "PAGO_PARCIAL";
    }

    if (
      estado === "PARTIALLY_REFUNDED" ||
      reembolsado > 0
    ) {
      return "PAGADO_CON_REEMBOLSO_PARCIAL";
    }

    return "PAGADO";
  }

  return "NO_PAGADO";
}

function grupoPrincipal(order) {
  return money(order, "totalReceivedSet") > 0
    ? "PAGADO"
    : "NO_PAGADO";
}

function crearMes() {
  return {
    ticketsTotales: 0,
    montoTotalTickets: 0,

    ticketsPagados: 0,
    montoRecibidoBruto: 0,
    reembolsos: 0,
    ventaNetaCobrada: 0,

    ticketsNoPagados: 0,
    montoNoPagado: 0,

    ticketsCancelados: 0,
    montoCancelado: 0,

    estados: {},
  };
}

function agregarEstado(
  mes,
  estado,
  totalPedido,
  recibido,
  reembolsado,
  neto
) {
  if (!mes.estados[estado]) {
    mes.estados[estado] = {
      tickets: 0,
      montoPedidos: 0,
      recibido: 0,
      reembolsado: 0,
      neto: 0,
    };
  }

  const e = mes.estados[estado];

  e.tickets++;
  e.montoPedidos += totalPedido;
  e.recibido += recibido;
  e.reembolsado += reembolsado;
  e.neto += neto;
}

// ======================================================
// EXCEL
// ======================================================

function aplicarEncabezado(worksheet, fila = 1) {
  const row = worksheet.getRow(fila);

  row.font = {
    bold: true,
  };

  row.alignment = {
    vertical: "middle",
    horizontal: "center",
  };

  row.height = 22;

  worksheet.views = [
    {
      state: "frozen",
      ySplit: fila,
    },
  ];

  worksheet.autoFilter = {
    from: {
      row: fila,
      column: 1,
    },
    to: {
      row: fila,
      column: worksheet.columnCount,
    },
  };
}

function aplicarFormatoMoneda(worksheet, columnas) {
  for (const columna of columnas) {
    worksheet.getColumn(columna).numFmt =
      '$#,##0.00;[Red]-$#,##0.00';
  }
}

function aplicarFormatoPct(worksheet, columnas) {
  for (const columna of columnas) {
    worksheet.getColumn(columna).numFmt = "0.00%";
  }
}

function ajustarAnchos(worksheet, min = 12, max = 35) {
  worksheet.columns.forEach((column) => {
    let ancho = min;

    column.eachCell(
      {
        includeEmpty: true,
      },
      (cell) => {
        const valor =
          cell.value == null
            ? ""
            : String(cell.value);

        ancho = Math.max(
          ancho,
          Math.min(
            max,
            valor.length + 2
          )
        );
      }
    );

    column.width = ancho;
  });
}

async function crearExcel(
  resumenMensual,
  detalle,
  estatusFinancieros
) {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Reporte Shopify";
  workbook.created = new Date();

  // --------------------------------------------------
  // HOJA 1: RESUMEN MENSUAL
  // --------------------------------------------------

  const wsResumen =
    workbook.addWorksheet("Resumen mensual");

  wsResumen.columns = [
    {
      header: "Mes",
      key: "mes",
    },
    {
      header: "Periodo",
      key: "periodo",
    },
    {
      header: "Tickets totales",
      key: "tickets_totales",
    },
    {
      header: "Monto total tickets",
      key: "monto_total_tickets",
    },
    {
      header: "Tickets pagados",
      key: "tickets_pagados",
    },
    {
      header: "% tickets pagados",
      key: "pct_tickets_pagados",
    },
    {
      header: "Monto recibido bruto",
      key: "monto_recibido_bruto",
    },
    {
      header: "Reembolsos",
      key: "reembolsos",
    },
    {
      header: "Venta neta cobrada",
      key: "venta_neta_cobrada",
    },
    {
      header: "Tickets no pagados",
      key: "tickets_no_pagados",
    },
    {
      header: "% tickets no pagados",
      key: "pct_tickets_no_pagados",
    },
    {
      header: "Monto de tickets no pagados",
      key: "monto_no_pagado",
    },
    {
      header: "Tickets cancelados",
      key: "tickets_cancelados",
    },
    {
      header: "Monto cancelado",
      key: "monto_cancelado",
    },
    {
      header: "Ticket promedio neto",
      key: "ticket_promedio_neto",
    },
  ];

  resumenMensual.forEach(
    (fila) => wsResumen.addRow(fila)
  );

  aplicarEncabezado(wsResumen);

  aplicarFormatoMoneda(
    wsResumen,
    [
      4,
      7,
      8,
      9,
      12,
      14,
      15,
    ]
  );

  aplicarFormatoPct(
    wsResumen,
    [
      6,
      11,
    ]
  );

  ajustarAnchos(
    wsResumen,
    14,
    28
  );

  // --------------------------------------------------
  // HOJA 2: DETALLE PEDIDOS
  // --------------------------------------------------

  const wsDetalle =
    workbook.addWorksheet("Detalle pedidos");

  wsDetalle.columns = [
    {
      header: "Pedido",
      key: "pedido",
    },
    {
      header: "Fecha creación",
      key: "fecha_creacion",
    },
    {
      header: "Mes",
      key: "mes",
    },
    {
      header: "Estado financiero",
      key: "estado_financiero",
    },
    {
      header: "Grupo",
      key: "grupo",
    },
    {
      header: "Clasificación",
      key: "clasificacion",
    },
    {
      header: "Cancelado",
      key: "cancelado",
    },
    {
      header: "Fecha cancelación",
      key: "fecha_cancelacion",
    },
    {
      header: "Pasarela",
      key: "pasarela",
    },
    {
      header: "Total pedido",
      key: "total_pedido",
    },
    {
      header: "Total recibido",
      key: "total_recibido",
    },
    {
      header: "Total reembolsado",
      key: "total_reembolsado",
    },
    {
      header: "Venta neta cobrada",
      key: "venta_neta_cobrada",
    },
    {
      header: "Saldo pendiente",
      key: "saldo_pendiente",
    },
    {
      header: "Moneda",
      key: "moneda",
    },
  ];

  detalle.forEach(
    (fila) => wsDetalle.addRow(fila)
  );

  aplicarEncabezado(wsDetalle);

  aplicarFormatoMoneda(
    wsDetalle,
    [
      10,
      11,
      12,
      13,
      14,
    ]
  );

  ajustarAnchos(
    wsDetalle,
    14,
    32
  );

  // --------------------------------------------------
  // HOJA 3: ESTATUS FINANCIEROS
  // --------------------------------------------------

  const wsEstatus =
    workbook.addWorksheet("Estatus financieros");

  wsEstatus.columns = [
    {
      header: "Mes",
      key: "mes",
    },
    {
      header: "Estado financiero",
      key: "estado_financiero",
    },
    {
      header: "Tickets",
      key: "tickets",
    },
    {
      header: "% tickets del mes",
      key: "pct_tickets_mes",
    },
    {
      header: "Monto pedidos",
      key: "monto_pedidos",
    },
    {
      header: "Monto recibido",
      key: "monto_recibido",
    },
    {
      header: "Monto reembolsado",
      key: "monto_reembolsado",
    },
    {
      header: "Venta neta cobrada",
      key: "venta_neta_cobrada",
    },
  ];

  estatusFinancieros.forEach(
    (fila) => wsEstatus.addRow(fila)
  );

  aplicarEncabezado(wsEstatus);

  aplicarFormatoMoneda(
    wsEstatus,
    [
      5,
      6,
      7,
      8,
    ]
  );

  aplicarFormatoPct(
    wsEstatus,
    [
      4,
    ]
  );

  ajustarAnchos(
    wsEstatus,
    14,
    28
  );

  fs.mkdirSync(
    OUTPUT_DIR,
    {
      recursive: true,
    }
  );

  await workbook.xlsx.writeFile(
    OUTPUT_FILE
  );
}

// ======================================================
// MAIN
// ======================================================

async function main() {
  console.log(
    "\n📊 VENTAS SHOPIFY - ÚLTIMOS 12 MESES"
  );

  console.log(
    `Periodo: ${DESDE} → hoy`
  );

  console.log(
    "Se excluyen pedidos de prueba.\n"
  );

  const token =
    await getAccessToken();

  const orders =
    await getOrders(token);

  console.log(
    `\n✅ Pedidos encontrados: ${orders.length}`
  );

  const meses = {};
  const detalle = [];

  for (
    const mesKey
    of generarMesesPeriodo()
  ) {
    meses[mesKey] =
      crearMes();
  }

  for (const order of orders) {
    const mesKey =
      getMesKey(
        order.createdAt
      );

    if (!meses[mesKey]) {
      continue;
    }

    const mes =
      meses[mesKey];

    const totalPedido =
      money(
        order,
        "totalPriceSet"
      );

    const recibido =
      money(
        order,
        "totalReceivedSet"
      );

    const reembolsado =
      money(
        order,
        "totalRefundedSet"
      );

    const neto =
      money(
        order,
        "netPaymentSet"
      );

    const saldoPendiente =
      money(
        order,
        "totalOutstandingSet"
      );

    const grupo =
      grupoPrincipal(order);

    const clasificacion =
      clasificarPago(order);

    const estado =
      order.displayFinancialStatus ||
      "SIN_ESTADO";

    const moneda =
      order.totalPriceSet
        ?.shopMoney
        ?.currencyCode ||
      "MXN";

    mes.ticketsTotales++;

    mes.montoTotalTickets +=
      totalPedido;

    mes.montoRecibidoBruto +=
      recibido;

    mes.reembolsos +=
      reembolsado;

    mes.ventaNetaCobrada +=
      neto;

    if (
      grupo === "PAGADO"
    ) {
      mes.ticketsPagados++;
    } else {
      mes.ticketsNoPagados++;

      mes.montoNoPagado +=
        totalPedido;
    }

    if (
      order.cancelledAt
    ) {
      mes.ticketsCancelados++;

      mes.montoCancelado +=
        totalPedido;
    }

    agregarEstado(
      mes,
      estado,
      totalPedido,
      recibido,
      reembolsado,
      neto
    );

    detalle.push({
      pedido:
        order.name,

      fecha_creacion:
        fechaLocal(
          order.createdAt
        ),

      mes:
        nombreMes(
          mesKey
        ),

      estado_financiero:
        estado,

      grupo,

      clasificacion,

      cancelado:
        order.cancelledAt
          ? "Sí"
          : "No",

      fecha_cancelacion:
        fechaLocal(
          order.cancelledAt
        ),

      pasarela:
        gatewaysPedido(
          order
        ),

      total_pedido:
        redondear(
          totalPedido
        ),

      total_recibido:
        redondear(
          recibido
        ),

      total_reembolsado:
        redondear(
          reembolsado
        ),

      venta_neta_cobrada:
        redondear(
          neto
        ),

      saldo_pendiente:
        redondear(
          saldoPendiente
        ),

      moneda,

      _fechaISO:
        order.createdAt,
    });
  }

  const resumenMensual = [];
  const estatusFinancieros = [];

  for (
    const mesKey
    of generarMesesPeriodo()
  ) {
    const m =
      meses[mesKey];

    resumenMensual.push({
      mes:
        nombreMes(
          mesKey
        ),

      periodo:
        mesKey === MES_ACTUAL_KEY
          ? "Mes parcial"
          : "Mes cerrado",

      tickets_totales:
        m.ticketsTotales,

      monto_total_tickets:
        redondear(
          m.montoTotalTickets
        ),

      tickets_pagados:
        m.ticketsPagados,

      pct_tickets_pagados:
        pct(
          m.ticketsPagados,
          m.ticketsTotales
        ) / 100,

      monto_recibido_bruto:
        redondear(
          m.montoRecibidoBruto
        ),

      reembolsos:
        redondear(
          m.reembolsos
        ),

      venta_neta_cobrada:
        redondear(
          m.ventaNetaCobrada
        ),

      tickets_no_pagados:
        m.ticketsNoPagados,

      pct_tickets_no_pagados:
        pct(
          m.ticketsNoPagados,
          m.ticketsTotales
        ) / 100,

      monto_no_pagado:
        redondear(
          m.montoNoPagado
        ),

      tickets_cancelados:
        m.ticketsCancelados,

      monto_cancelado:
        redondear(
          m.montoCancelado
        ),

      ticket_promedio_neto:
        redondear(
          m.ticketsPagados
            ? m.ventaNetaCobrada /
              m.ticketsPagados
            : 0
        ),
    });

    const estadosOrdenados =
      Object.keys(
        m.estados
      ).sort();

    for (
      const estado
      of estadosOrdenados
    ) {
      const e =
        m.estados[estado];

      estatusFinancieros.push({
        mes:
          nombreMes(
            mesKey
          ),

        estado_financiero:
          estado,

        tickets:
          e.tickets,

        pct_tickets_mes:
          pct(
            e.tickets,
            m.ticketsTotales
          ) / 100,

        monto_pedidos:
          redondear(
            e.montoPedidos
          ),

        monto_recibido:
          redondear(
            e.recibido
          ),

        monto_reembolsado:
          redondear(
            e.reembolsado
          ),

        venta_neta_cobrada:
          redondear(
            e.neto
          ),
      });
    }
  }

  detalle.sort(
    (a, b) =>
      new Date(a._fechaISO) -
      new Date(b._fechaISO)
  );

  detalle.forEach(
    (fila) =>
      delete fila._fechaISO
  );

  await crearExcel(
    resumenMensual,
    detalle,
    estatusFinancieros
  );

  console.log(
    "\n=============================================="
  );

  console.log(
    "✅ EXCEL GENERADO"
  );

  console.log(
    "==============================================\n"
  );

  console.log(
    OUTPUT_FILE
  );

  console.log(
    `Pedidos incluidos: ${detalle.length}`
  );

  console.log(
    `Meses: ${resumenMensual.length}`
  );

  console.log(
    "\n📅 RESUMEN MENSUAL\n"
  );

  for (
    const fila
    of resumenMensual
  ) {
    console.log(
      `${fila.mes.padEnd(20)} | ` +
        `Tickets: ${String(
          fila.tickets_totales
        ).padStart(4)} | ` +
        `Pagados: ${String(
          fila.tickets_pagados
        ).padStart(4)} | ` +
        `No pagados: ${String(
          fila.tickets_no_pagados
        ).padStart(4)} | ` +
        `Neto: $${fila.venta_neta_cobrada.toLocaleString(
          "es-MX",
          {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }
        )}`
    );
  }

  console.log(
    "\n✅ Exportación terminada."
  );
}

main().catch(
  (error) => {
    console.error(
      "❌ Error:",
      error
    );

    process.exit(1);
  }
);