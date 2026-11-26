FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /hinacode-relayd .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /hinacode-relayd /hinacode-relayd
EXPOSE 8443
ENTRYPOINT ["/hinacode-relayd"]
