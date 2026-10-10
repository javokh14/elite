export default {
  async fetch(request, env) {
    return new Response("Elite Stars Bot ishlayapti ✅", {
      headers: {
        "content-type": "text/plain; charset=UTF-8"
      }
    });
  }
};