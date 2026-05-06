import http.server
import os

os.chdir('/Users/SurfingAlien/Downloads/FinSurfing')

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

http.server.test(HandlerClass=Handler, port=4200, bind='127.0.0.1')
