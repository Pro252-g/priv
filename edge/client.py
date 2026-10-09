"""Bounded HTTPS API client. No exception text or credential URLs are logged."""
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request

from config import EdgeError


class ApiError(EdgeError):
    def __init__(self, code, status=None):
        self.status = status
        super().__init__(code)


class ApiClient:
    def __init__(self, config, environ=None):
        environ = os.environ if environ is None else environ
        self.config = config
        self.base = config['baseUrl']
        self.key = environ[config.get('apiKeyEnv', 'IEP_API_KEY')]
        self.context = ssl.create_default_context(cafile=config.get('caFile'))
        # Do not inherit ambient HTTP proxies for LAN/cloud credentials.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=self.context), NoRedirect())

    def request(self, endpoint, payload=None, binary=False):
        if not endpoint.startswith('/api/') or endpoint.startswith('//') or '#' in endpoint or '\n' in endpoint or '\r' in endpoint:
            raise ApiError('invalid_api_endpoint')
        data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode() if payload is not None else None
        request = urllib.request.Request(self.base + endpoint, data=data, headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST' if data is not None else 'GET')
        try:
            with self.opener.open(request, timeout=self.config.get('timeoutSec', 8)) as response:
                # API body limit caps each JPEG/reference; malicious replies cannot
                # grow worker memory or inject JSON into diagnostics.
                content = response.read(3*1024*1024 + 1)
                if len(content) > 3*1024*1024:
                    raise ApiError('api_response_too_large')
                if binary:
                    return content
                return json.loads(content)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise ApiError('auth_failed', error.code) from None
            if error.code == 409:
                raise ApiError('identity_conflict', 409) from None
            if error.code in (408, 429) or error.code >= 500:
                raise ApiError('upload_failed', error.code) from None
            raise ApiError('request_rejected', error.code) from None
        except ApiError:
            raise
        except (OSError, ValueError, urllib.error.URLError):
            raise ApiError('cloud_unreachable') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Authorization must never follow redirects to another origin.
        raise ApiError('api_redirect_refused', code)
