import { createServer, seedDemoService } from "./server.js";
import { runConsumerDemo } from "./connector.js";

const server = createServer();
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await seedDemoService(baseUrl, server.store);
    const demo = await runConsumerDemo({ baseUrl });
    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      selected_service: demo.selected_service.service_id,
      manifest_title: demo.manifest_title,
      preview_sample_type: demo.preview_sample_type,
      paid_status: demo.paid_result.status,
      payment_tx: demo.feedback_event.payment_tx,
      feedback_count: demo.feedback_count,
      analysis: demo.analysis
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      payload: error.payload
    }, null, 2));
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
