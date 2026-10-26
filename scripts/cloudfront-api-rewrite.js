function handler(event) {
  var request = event.request;

  if (request.uri.indexOf("/api/") === 0) {
    request.uri = request.uri.slice(4) || "/";
  }

  return request;
}
