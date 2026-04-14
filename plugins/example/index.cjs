/**
 * hello-world — the canonical theorchestra plugin.
 *
 * Demonstrates every piece of the plugin API:
 *  - ctx.on(event, handler)   subscribe to watcher events
 *  - ctx.emit(event, payload) publish a custom event to the stdout stream
 *  - ctx.readOutput(paneId)   read a pane's scrollback
 *  - ctx.log(msg)             append to the host's stderr
 *
 * To disable this plugin, rename the folder to `_example/`.
 */
module.exports = {
  name: 'hello-world',

  register(ctx) {
    ctx.log('hello-world loaded');

    ctx.on('session_started', (ev) => {
      ctx.log(`new session in ${ev.project || 'unknown'} (pane ${ev.pane})`);
      ctx.emit('hello', { pane: ev.pane, project: ev.project });
    });

    ctx.on('session_completed', (ev) => {
      ctx.log(`pane ${ev.pane} completed a task`);
    });

    // Wildcard subscription — gets every event, useful for logging
    // ctx.on('*', (ev) => ctx.log(`saw ${ev.event}`));

    // React to your own emits (round-trips through the watcher stdout)
    ctx.on('hello', (ev) => {
      // no-op in hello-world, but this is where a richer plugin would
      // chain behaviors on its own published events.
    });
  },
};
