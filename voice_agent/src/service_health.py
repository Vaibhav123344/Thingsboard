"""
service_health.py — Background health monitor for STT/TTS microservices.

Periodically pings /health endpoints, tracks availability state,
and supports blocking until all services are ready (startup gating).
"""

import asyncio
import contextlib
import logging
import time

import aiohttp

logger = logging.getLogger("service-health")


class ServiceHealth:
    """Background health monitor for STT/TTS microservices.

    Usage:
        health = ServiceHealth({
            "stt": "http://localhost:8765",
            "tts": "http://localhost:8766",
        })
        await health.start()          # begins periodic checks
        await health.wait_for_services()  # blocks until all healthy
        ...
        await health.stop()           # cleanup
    """

    def __init__(
        self,
        services: dict[str, str],
        check_interval: float = 10.0,
        timeout: float = 5.0,
    ):
        self.services = services  # {"stt": "http://...", "tts": "http://..."}
        self.health: dict[str, bool] = dict.fromkeys(services, False)
        self._latency: dict[str, float] = dict.fromkeys(services, 0.0)
        self._interval = check_interval
        self._timeout = timeout
        self._task: asyncio.Task | None = None
        self._session: aiohttp.ClientSession | None = None
        self._ready_event = asyncio.Event()

    async def start(self) -> None:
        """Start the background health check loop."""
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self._timeout)
        )
        self._task = asyncio.create_task(self._check_loop())
        logger.info(
            f"Health monitor started for {list(self.services.keys())} "
            f"(interval={self._interval}s)"
        )

    async def stop(self) -> None:
        """Stop the health check loop and cleanup."""
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self._session:
            await self._session.close()
        logger.info("Health monitor stopped.")

    async def wait_for_services(self, timeout: float = 120.0) -> bool:
        """Block until all services are healthy, or timeout.

        Returns True if all services are healthy, False on timeout.
        """
        logger.info(f"Waiting for services to become healthy (timeout={timeout}s)...")
        try:
            await asyncio.wait_for(self._ready_event.wait(), timeout=timeout)
            logger.info("All services are healthy and ready!")
            return True
        except asyncio.TimeoutError:
            unhealthy = [name for name, ok in self.health.items() if not ok]
            logger.error(f"Timeout waiting for services. Still unhealthy: {unhealthy}")
            return False

    def is_healthy(self, service: str) -> bool:
        """Check if a specific service is currently healthy."""
        return self.health.get(service, False)

    def all_healthy(self) -> bool:
        """Check if all services are currently healthy."""
        return all(self.health.values())

    def get_status(self) -> dict[str, dict]:
        """Get detailed status of all services."""
        return {
            name: {
                "healthy": self.health[name],
                "url": self.services[name],
                "latency_ms": round(self._latency[name], 1),
            }
            for name in self.services
        }

    async def _check_once(self, name: str, base_url: str) -> bool:
        """Check a single service's health endpoint."""
        url = f"{base_url}/health"
        try:
            async with self._session.get(url) as resp:
                if resp.status == 200:
                    return True
                logger.warning(f"Health check {name} returned status {resp.status}")
                return False
        except aiohttp.ClientError as e:
            logger.debug(f"Health check {name} failed: {e}")
            return False
        except Exception as e:
            logger.debug(f"Health check {name} error: {e}")
            return False

    async def _check_loop(self) -> None:
        """Periodically check all service health endpoints."""
        while True:
            try:
                for name, base_url in self.services.items():
                    t0 = time.perf_counter()
                    was_healthy = self.health[name]
                    is_now_healthy = await self._check_once(name, base_url)
                    elapsed_ms = (time.perf_counter() - t0) * 1000
                    self._latency[name] = elapsed_ms

                    if was_healthy and not is_now_healthy:
                        logger.warning(
                            f"Service {name!r} became UNHEALTHY (url={base_url})"
                        )
                    elif not was_healthy and is_now_healthy:
                        logger.info(
                            f"Service {name!r} is now HEALTHY "
                            f"(latency={elapsed_ms:.0f}ms)"
                        )

                    self.health[name] = is_now_healthy

                # Update ready event
                if self.all_healthy():
                    self._ready_event.set()
                else:
                    self._ready_event.clear()

            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Health check loop error: {e}")

            await asyncio.sleep(self._interval)
