"""Input adapter boundary; legacy InputHandler remains the first implementation."""


class InputAdapter:
    def __init__(self, implementation):
        self.implementation = implementation

    def start(self):
        return self.implementation.start()

    async def handle_input(self, data):
        return await self.implementation.handle_input(data)

    async def apply_keyboard(self, data, transport="socket"):
        return await self.implementation.apply_keyboard(data, transport=transport)

    def __getattr__(self, name):
        return getattr(self.implementation, name)
