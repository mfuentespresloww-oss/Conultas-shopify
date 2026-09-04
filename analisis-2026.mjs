const STORE = process.env.SHOPIFY_STORE
  ?.replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const DESDE = "2026-01-01T00:00:00-06:00";
const TIMEZONE = "America/Mexico_City";

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Faltan datos en .env");
  process.exit(1);
}

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

async function graphql(token, query, variables = {}) {
  const response = await fetch(
    `https://${STORE}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
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

async function getOrders(token) {
  const query = `
    query Pedidos2026($after: String, $query: String!) {
      orders(
        first: 100
        after: $after
        sortKey: CREATED_AT
        query: $query
      ) {
        nodes {
          name
          createdAt
          cancelledAt
          displayFinancialStatus
          paymentGatewayNames

          totalPriceSet {
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

          events(first: 100) {
            nodes {
              action
              createdAt
              message
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
      query: `created_at:>=${DESDE}`,
    });

    orders.push(...data.orders.nodes);

    after = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;

    pagina++;
  } while (after);

  return orders;
}

function dinero(numero) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
  }).format(numero);
}

function porcentaje(numero) {
  return `${numero.toFixed(2)}%`;
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

function nombreMes(mesKey) {
  const [year, month] = mesKey.split("-");

  const fecha = new Date(
    Number(year),
    Number(month) - 1,
    1
  );

  return new Intl.DateTimeFormat("es-MX", {
    month: "long",
    year: "numeric",
  }).format(fecha);
}

function mediana(valores) {
  if (!valores.length) return null;

  const ordenados = [...valores].sort((a, b) => a - b);
  const mitad = Math.floor(ordenados.length / 2);

  if (ordenados.length % 2 === 0) {
    return (
      (ordenados[mitad - 1] + ordenados[mitad]) / 2
    );
  }

  return ordenados[mitad];
}

function analizarPedido(order) {
  const eventos = [...order.events.nodes].sort(
    (a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
  );

  const eventosPending = eventos.filter((e) =>
    [
      "sale_pending",
      "authorization_pending",
      "capture_pending",
    ].includes(e.action)
  );

  if (!eventosPending.length) {
    return {
      esPending: false,
    };
  }

  const primerPending = eventosPending[0];

  const posteriores = eventos.filter(
    (e) =>
      new Date(e.createdAt) >=
      new Date(primerPending.createdAt)
  );

  const success = posteriores.find((e) =>
    [
      "sale_success",
      "capture_success",
    ].includes(e.action)
  );

  const failure = posteriores.find((e) =>
    [
      "sale_failure",
      "capture_failure",
      "authorization_failure",
    ].includes(e.action)
  );

  const cancelled = posteriores.find(
    (e) => e.action === "cancelled"
  );

  const estado = order.displayFinancialStatus;

  const estadoQueIndicaCobro = [
    "PAID",
    "PARTIALLY_PAID",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
  ].includes(estado);

  let resultado;

  if (success || estadoQueIndicaCobro) {
    resultado = "PAGADO";
  } else if (
    failure ||
    cancelled ||
    ["EXPIRED", "VOIDED"].includes(estado)
  ) {
    resultado = "NO_CONVERTIDO";
  } else {
    resultado = "PENDIENTE";
  }

  let minutosConversion = null;

  if (success) {
    minutosConversion =
      (new Date(success.createdAt) -
        new Date(primerPending.createdAt)) /
      60000;
  }

  return {
    esPending: true,
    resultado,
    primerPending,
    success,
    failure,
    cancelled,
    minutosConversion,
  };
}

function crearMes() {
  return {
    pedidosTotales: 0,

    ventaNetaTotal: 0,

    pendingTotal: 0,
    pagados: 0,
    noConvertidos: 0,
    pendientes: 0,

    ventaRecuperada: 0,
    valorNoConvertido: 0,
    valorPendiente: 0,

    tiemposConversion: [],

    gateways: {},
  };
}

async function main() {
  console.log("\n📊 ANÁLISIS ANUAL PEDIDOS PENDIENTES");
  console.log("Periodo: 1 enero 2026 → hoy\n");

  const token = await getAccessToken();
  const orders = await getOrders(token);

  console.log(
    `\n✅ Pedidos encontrados en 2026: ${orders.length}\n`
  );

  const meses = {};

  for (const order of orders) {
    const mes = getMesKey(order.createdAt);

    // Solo queremos 2026
    if (!mes.startsWith("2026-")) continue;

    if (!meses[mes]) {
      meses[mes] = crearMes();
    }

    const datosMes = meses[mes];

    datosMes.pedidosTotales++;

    const neto = Number(
      order.netPaymentSet?.shopMoney?.amount || 0
    );

    datosMes.ventaNetaTotal += neto;

    const analisis = analizarPedido(order);

    if (!analisis.esPending) continue;

    datosMes.pendingTotal++;

    const totalPedido = Number(
      order.totalPriceSet?.shopMoney?.amount || 0
    );

    const gateway =
      order.paymentGatewayNames?.join(", ") ||
      "Sin identificar";

    if (!datosMes.gateways[gateway]) {
      datosMes.gateways[gateway] = {
        total: 0,
        pagados: 0,
        noConvertidos: 0,
        pendientes: 0,
        ventaRecuperada: 0,
        valorNoConvertido: 0,
      };
    }

    const datosGateway =
      datosMes.gateways[gateway];

    datosGateway.total++;

    if (analisis.resultado === "PAGADO") {
      datosMes.pagados++;
      datosMes.ventaRecuperada += neto;

      datosGateway.pagados++;
      datosGateway.ventaRecuperada += neto;

      if (
        analisis.minutosConversion !== null
      ) {
        datosMes.tiemposConversion.push(
          analisis.minutosConversion
        );
      }
    }

    if (
      analisis.resultado === "NO_CONVERTIDO"
    ) {
      datosMes.noConvertidos++;
      datosMes.valorNoConvertido += totalPedido;

      datosGateway.noConvertidos++;
      datosGateway.valorNoConvertido +=
        totalPedido;
    }

    if (analisis.resultado === "PENDIENTE") {
      datosMes.pendientes++;
      datosMes.valorPendiente += totalPedido;

      datosGateway.pendientes++;
    }
  }

  console.log(
    "================================================================================"
  );

  console.log("📅 RESUMEN POR MES\n");

  const mesesOrdenados = Object.keys(meses).sort();

  let acumulado = {
    pedidosTotales: 0,
    pendingTotal: 0,
    pagados: 0,
    noConvertidos: 0,
    pendientes: 0,

    ventaNetaTotal: 0,
    ventaRecuperada: 0,
    valorNoConvertido: 0,
    valorPendiente: 0,
  };

  for (const mes of mesesOrdenados) {
    const m = meses[mes];

    const resueltos =
      m.pagados + m.noConvertidos;

    const conversion =
      resueltos > 0
        ? (m.pagados / resueltos) * 100
        : 0;

    const incidenciaPending =
      m.pedidosTotales > 0
        ? (m.pendingTotal /
            m.pedidosTotales) *
          100
        : 0;

    const porcentajeVentaRecuperada =
      m.ventaNetaTotal > 0
        ? (m.ventaRecuperada /
            m.ventaNetaTotal) *
          100
        : 0;

    const porcentajeNoConvertido =
      m.ventaNetaTotal > 0
        ? (m.valorNoConvertido /
            m.ventaNetaTotal) *
          100
        : 0;

    const promedio =
      m.tiemposConversion.length > 0
        ? m.tiemposConversion.reduce(
            (a, b) => a + b,
            0
          ) /
          m.tiemposConversion.length
        : null;

    const medianaMes = mediana(
      m.tiemposConversion
    );

    console.log(
      "------------------------------------------------------------"
    );

    console.log(
      nombreMes(mes).toUpperCase()
    );

    console.log(
      `Pedidos totales: ${m.pedidosTotales}`
    );

    console.log(
      `Pedidos PENDING: ${m.pendingTotal} (${porcentaje(
        incidenciaPending
      )})`
    );

    console.log(
      `🟢 Pagaron: ${m.pagados}`
    );

    console.log(
      `🔴 No convirtieron: ${m.noConvertidos}`
    );

    console.log(
      `🟡 Siguen pendientes: ${m.pendientes}`
    );

    console.log(
      `🎯 Conversión PENDING: ${porcentaje(
        conversion
      )}`
    );

    console.log("");

    console.log(
      `💰 Venta neta total: ${dinero(
        m.ventaNetaTotal
      )}`
    );

    console.log(
      `💚 Venta de PENDING recuperados: ${dinero(
        m.ventaRecuperada
      )}`
    );

    console.log(
      `📊 Recuperados / venta total: ${porcentaje(
        porcentajeVentaRecuperada
      )}`
    );

    console.log(
      `💔 Valor PENDING no convertido: ${dinero(
        m.valorNoConvertido
      )}`
    );

    console.log(
      `📉 No convertido / venta total: ${porcentaje(
        porcentajeNoConvertido
      )}`
    );

    console.log(
      `⏳ Valor aún pendiente: ${dinero(
        m.valorPendiente
      )}`
    );

    if (promedio !== null) {
      console.log(
        `⏱️ Tiempo promedio a pago: ${promedio.toFixed(
          1
        )} min`
      );
    }

    if (medianaMes !== null) {
      console.log(
        `⏱️ Mediana a pago: ${medianaMes.toFixed(
          1
        )} min`
      );
    }

    acumulado.pedidosTotales +=
      m.pedidosTotales;

    acumulado.pendingTotal +=
      m.pendingTotal;

    acumulado.pagados += m.pagados;

    acumulado.noConvertidos +=
      m.noConvertidos;

    acumulado.pendientes +=
      m.pendientes;

    acumulado.ventaNetaTotal +=
      m.ventaNetaTotal;

    acumulado.ventaRecuperada +=
      m.ventaRecuperada;

    acumulado.valorNoConvertido +=
      m.valorNoConvertido;

    acumulado.valorPendiente +=
      m.valorPendiente;
  }

  const resueltosAcumulado =
    acumulado.pagados +
    acumulado.noConvertidos;

  const conversionAcumulada =
    resueltosAcumulado > 0
      ? (acumulado.pagados /
          resueltosAcumulado) *
        100
      : 0;

  const incidenciaAcumulada =
    acumulado.pedidosTotales > 0
      ? (acumulado.pendingTotal /
          acumulado.pedidosTotales) *
        100
      : 0;

  const recuperadoVentaAcumulada =
    acumulado.ventaNetaTotal > 0
      ? (acumulado.ventaRecuperada /
          acumulado.ventaNetaTotal) *
        100
      : 0;

  const noConvertidoVentaAcumulada =
    acumulado.ventaNetaTotal > 0
      ? (acumulado.valorNoConvertido /
          acumulado.ventaNetaTotal) *
        100
      : 0;

  console.log(
    "\n================================================================================"
  );

  console.log("📊 ACUMULADO 2026\n");

  console.log(
    `Pedidos totales: ${acumulado.pedidosTotales}`
  );

  console.log(
    `Pedidos que pasaron por PENDING: ${acumulado.pendingTotal}`
  );

  console.log(
    `% de pedidos que pasaron por PENDING: ${porcentaje(
      incidenciaAcumulada
    )}`
  );

  console.log("");

  console.log(
    `🟢 PENDING que pagaron: ${acumulado.pagados}`
  );

  console.log(
    `🔴 PENDING que no convirtieron: ${acumulado.noConvertidos}`
  );

  console.log(
    `🟡 Siguen pendientes: ${acumulado.pendientes}`
  );

  console.log(
    `🎯 Conversión PENDING: ${porcentaje(
      conversionAcumulada
    )}`
  );

  console.log("");

  console.log(
    `💰 Venta neta total: ${dinero(
      acumulado.ventaNetaTotal
    )}`
  );

  console.log(
    `💚 Venta de PENDING recuperados: ${dinero(
      acumulado.ventaRecuperada
    )}`
  );

  console.log(
    `📊 Recuperados / venta total: ${porcentaje(
      recuperadoVentaAcumulada
    )}`
  );

  console.log(
    `💔 Valor PENDING no convertido: ${dinero(
      acumulado.valorNoConvertido
    )}`
  );

  console.log(
    `📉 No convertido / venta total: ${porcentaje(
      noConvertidoVentaAcumulada
    )}`
  );

  console.log(
    `⏳ Valor todavía pendiente: ${dinero(
      acumulado.valorPendiente
    )}`
  );

  console.log(
    "\n================================================================================"
  );

  console.log(
    "🏦 PASARELAS POR MES\n"
  );

  for (const mes of mesesOrdenados) {
    const m = meses[mes];

    console.log(
      `\n${nombreMes(mes).toUpperCase()}`
    );

    for (const [
      gateway,
      g,
    ] of Object.entries(m.gateways)) {
      const resueltos =
        g.pagados + g.noConvertidos;

      const conversion =
        resueltos > 0
          ? (g.pagados / resueltos) * 100
          : 0;

      console.log(
        `${gateway} | Pending: ${g.total} | Pagaron: ${g.pagados} | No convirtieron: ${g.noConvertidos} | Abiertos: ${g.pendientes} | Conversión: ${porcentaje(
          conversion
        )} | Recuperado: ${dinero(
          g.ventaRecuperada
        )}`
      );
    }
  }
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});