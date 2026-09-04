import { google } from "googleapis";

const SPREADSHEET_ID =
  "1Z5okxtAXL5DZ7zfgeztZv_PTdGqAY-KDhf5AN7AonFk";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "./google-service-account.json",
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const response = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  console.log("✅ CONEXIÓN CORRECTA CON GOOGLE SHEETS");
  console.log("Archivo:", response.data.properties.title);

  console.log("\nPestañas:");

  for (const sheet of response.data.sheets) {
    console.log(
      "-",
      sheet.properties.title
    );
  }
}

main().catch((error) => {
  console.error("❌ ERROR:");
  console.error(
    error.response?.data || error.message
  );
});