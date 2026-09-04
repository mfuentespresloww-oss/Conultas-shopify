const STORE = process.env.SHOPIFY_STORE
  ?.replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

// Agosto 2026 - horario CDMX
const DESDE = "2026-08-01T00:00:00-06:00";

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
    query PedidosMes($after: String, $query: String!) {
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

          currentTotalPriceSet {
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

function analizarPedido(order) {
  const eventos = [...order.events.nodes].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
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
    ["sale_success", "capture_success"].includes(e.action)
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

  // Shopify puede conservar el pedido como REFUNDED
  // aunque previamente sí haya convertido.
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

async function main() {
  console.log("\n📊 ANÁLISIS PEDIDOS PENDIENTES");
  console.log("Periodo: 1 agosto 2026 → hoy\n");

  const token = await getAccessToken();
  const orders = await getOrders(token);

  console.log(`\n✅ Pedidos del periodo: ${orders.length}\n`);

  let totalVentaNeta = 0;

  let pendientesTotal = 0;
  let convertidos = 0;
  let noConvertidos = 0;
  let siguenPendientes = 0;

  let ventaRecuperada = 0;
  let ventaPerdidaPotencial = 0;
  let ventaPendiente = 0;

  const tiemposConversion = [];

  const detalle = [];

  const porGateway = {};

  for (const order of orders) {
    const neto = Number(
      order.netPaymentSet?.shopMoney?.amount || 0
    );

    totalVentaNeta += neto;

    const analisis = analizarPedido(order);

    if (!analisis.esPending) continue;

    pendientesTotal++;

    const totalPedido = Number(
      order.totalPriceSet?.shopMoney?.amount || 0
    );

    const gateway =
      order.paymentGatewayNames?.join(", ") ||
      "Sin identificar";

    if (!porGateway[gateway]) {
      porGateway[gateway] = {
        total: 0,
        pagados: 0,
        noConvertidos: 0,
        pendientes: 0,
        ventaRecuperada: 0,
        perdidaPotencial: 0,
      };
    }

    porGateway[gateway].total++;

    if (analisis.resultado === "PAGADO") {
      convertidos++;

      // Venta real cobrada menos reembolsos
      ventaRecuperada += neto;

      porGateway[gateway].pagados++;
      porGateway[gateway].ventaRecuperada += neto;

      if (analisis.minutosConversion !== null) {
        tiemposConversion.push(
          analisis.minutosConversion
        );
      }
    }

    if (analisis.resultado === "NO_CONVERTIDO") {
      noConvertidos++;
      ventaPerdidaPotencial += totalPedido;

      porGateway[gateway].noConvertidos++;
      porGateway[gateway].perdidaPotencial +=
        totalPedido;
    }

    if (analisis.resultado === "PENDIENTE") {
      siguenPendientes++;
      ventaPendiente += totalPedido;

      porGateway[gateway].pendientes++;
    }

    detalle.push({
      pedido: order.name,
      fecha: order.createdAt,
      gateway,
      total: totalPedido,
      estadoActual: order.displayFinancialStatus,
      resultado: analisis.resultado,
      minutos: analisis.minutosConversion,
    });
  }

  const resueltos =
    convertidos + noConvertidos;

  const tasaConversion =
    resueltos > 0
      ? (convertidos / resueltos) * 100
      : 0;

  const porcentajePedidosPending =
    orders.length > 0
      ? (pendientesTotal / orders.length) * 100
      : 0;

  const participacionVenta =
    totalVentaNeta > 0
      ? (ventaRecuperada / totalVentaNeta) * 100
      : 0;

  const tiempoPromedio =
    tiemposConversion.length > 0
      ? tiemposConversion.reduce(
          (a, b) => a + b,
          0
        ) / tiemposConversion.length
      : null;

  console.log(
    "===================================================="
  );

  console.log("📦 RESUMEN GENERAL\n");

  console.log(
    "Pedidos totales del mes:",
    orders.length
  );

  console.log(
    "Pedidos que pasaron por PENDING:",
    pendientesTotal
  );

  console.log(
    "% de pedidos que pasaron por PENDING:",
    porcentaje(porcentajePedidosPending)
  );

  console.log("");

  console.log(
    "🟢 Pendientes que PAGARON:",
    convertidos
  );

  console.log(
    "🔴 Pendientes que NO CONVIRTIERON:",
    noConvertidos
  );

  console.log(
    "🟡 Pendientes todavía abiertos:",
    siguenPendientes
  );

  console.log("");

  console.log(
    "🎯 TASA DE CONVERSIÓN DE PENDIENTES RESUELTOS:",
    porcentaje(tasaConversion)
  );

  console.log("");

  console.log(
    "💰 Venta neta total del periodo:",
    dinero(totalVentaNeta)
  );

  console.log(
    "💚 Venta proveniente de pendientes recuperados:",
    dinero(ventaRecuperada)
  );

  console.log(
    "📊 % de la venta proveniente de pendientes recuperados:",
    porcentaje(participacionVenta)
  );

  console.log("");

  console.log(
    "💔 Valor de pedidos pendientes no convertidos:",
    dinero(ventaPerdidaPotencial)
  );

  console.log(
    "⏳ Valor que todavía sigue pendiente:",
    dinero(ventaPendiente)
  );

  if (tiempoPromedio !== null) {
    console.log(
      "\n⏱️ Tiempo promedio PENDING → PAGADO:",
      `${tiempoPromedio.toFixed(1)} minutos`
    );
  }

  console.log(
    "\n===================================================="
  );

  console.log("🏦 RESULTADO POR PASARELA\n");

  for (const [gateway, datos] of Object.entries(
    porGateway
  )) {
    const resueltosGateway =
      datos.pagados + datos.noConvertidos;

    const conversionGateway =
      resueltosGateway > 0
        ? (datos.pagados / resueltosGateway) * 100
        : 0;

    console.log(gateway);
    console.log(
      `  Pendientes detectados: ${datos.total}`
    );
    console.log(
      `  🟢 Pagaron: ${datos.pagados}`
    );
    console.log(
      `  🔴 No convirtieron: ${datos.noConvertidos}`
    );
    console.log(
      `  🟡 Siguen pendientes: ${datos.pendientes}`
    );
    console.log(
      `  Conversión resueltos: ${porcentaje(
        conversionGateway
      )}`
    );
    console.log(
      `  Venta recuperada: ${dinero(
        datos.ventaRecuperada
      )}`
    );
    console.log("");
  }

  console.log(
    "===================================================="
  );

  console.log("\n📋 DETALLE DE PEDIDOS PENDING\n");

  detalle
    .sort(
      (a, b) =>
        new Date(a.fecha) - new Date(b.fecha)
    )
    .forEach((p) => {
      console.log(
        `${p.pedido} | ${p.gateway} | ${dinero(
          p.total
        )} | ${p.estadoActual} | ${p.resultado}` +
          (p.minutos !== null
            ? ` | ${p.minutos.toFixed(1)} min`
            : "")
      );
    });
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});