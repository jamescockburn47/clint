/** Consume streamed inference promptly; retain final content, never reasoning deltas. */
export async function backgroundResponse(response) {
  const streaming = response.headers.get('content-type')?.includes('text/event-stream');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, buffer = '', content = '', finish = null, doneMarker = false;
  const consume = line => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (value === '[DONE]') { doneMarker = true; return; }
    if (!value) return;
    const data = JSON.parse(value);
    if (data.error) throw Error('background_model_stream_error');
    const choice = data.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (content.length > 2097152) throw Error('background_model_response_too_large');
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (streaming ? 16777216 : 2097152)) throw Error('background_model_response_too_large');
      buffer += decoder.decode(value, { stream: true });
      if (streaming) {
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          consume(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1);
        }
      }
    }
    buffer += decoder.decode();
    if (streaming) {
      if (buffer.trim()) consume(buffer.replace(/\r$/, ''));
      if (!doneMarker) throw Error('background_model_incomplete');
    } else {
      const choice = JSON.parse(buffer).choices?.[0];
      finish = choice?.finish_reason; content = choice?.message?.content;
    }
    if (finish !== 'stop' || typeof content !== 'string' || !content.trim()) throw Error('background_model_incomplete');
    return content;
  } finally { await reader.cancel(); reader.releaseLock(); }
}
