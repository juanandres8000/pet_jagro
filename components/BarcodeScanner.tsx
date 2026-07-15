'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import QuantityModal from './QuantityModal';
import ProductSelectionModal from './ProductSelectionModal';
import { Product } from '@/types';
import { Button } from '@/components/ui';

interface BarcodeScannerProps {
  onScanSuccess: (barcode: string, quantity?: number) => void;
  onClose: () => void;
  expectedBarcode: string;
  productName: string;
  allProducts?: Product[]; // Lista completa de productos para búsqueda
}

// Función para calcular la mediana de los errores
function getMedian(arr: number[]): number {
  const newArr = [...arr];
  newArr.sort((a, b) => a - b);
  const half = Math.floor(newArr.length / 2);
  if (newArr.length % 2 === 1) {
    return newArr[half];
  }
  return (newArr[half - 1] + newArr[half]) / 2;
}

export default function BarcodeScanner({
  onScanSuccess,
  onClose,
  expectedBarcode,
  productName,
  allProducts = [],
}: BarcodeScannerProps) {
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const scannerRef = useRef<HTMLDivElement | null>(null);

  // Estado para el modal de cantidad
  const [showQuantityModal, setShowQuantityModal] = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState('');

  // Estado para modal de selección de productos (códigos duplicados)
  const [showProductSelection, setShowProductSelection] = useState(false);
  const [duplicateProducts, setDuplicateProducts] = useState<Product[]>([]);

  // Estado para búsqueda de productos
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Función para búsqueda inteligente
  const handleSearchChange = (value: string) => {
    setManualCode(value);

    // Si el campo está vacío, ocultar sugerencias
    if (value.length < 2) {
      setShowSuggestions(false);
      setSearchResults([]);
      return;
    }

    // Detectar si es búsqueda por código (solo números) o por nombre (contiene texto)
    const isNumericSearch = /^\d+$/.test(value);

    if (allProducts.length > 0) {
      let filtered: Product[] = [];

      if (isNumericSearch) {
        // Buscar por código de barras que coincida con el esperado
        filtered = allProducts.filter(p =>
          p.barcode === expectedBarcode && p.barcode.includes(value)
        );
      } else {
        // Buscar por nombre, pero solo productos con el mismo código que el esperado
        filtered = allProducts.filter(p =>
          p.barcode === expectedBarcode &&
          p.name.toLowerCase().includes(value.toLowerCase())
        );
      }

      setSearchResults(filtered.slice(0, 5)); // Máximo 5 resultados
      setShowSuggestions(filtered.length > 0);
    }
  };

  // Seleccionar un producto de las sugerencias
  const handleSelectProduct = (product: Product) => {
    setManualCode(product.barcode);
    setShowSuggestions(false);
    setSearchResults([]);
    // Como ya filtramos por código esperado, siempre es correcto
    // Ir directo a modal de cantidad (saltarse modal de duplicados)
    setScannedBarcode(product.barcode);
    setShowQuantityModal(true);
  };

  // Función para abrir el modal de cantidad después de un escaneo exitoso
  const handleSuccessfulScan = (barcode: string) => {
    setScannedBarcode(barcode);

    // Verificar si hay productos duplicados con este código
    if (allProducts.length > 0) {
      const matchingProducts = allProducts.filter(p => p.barcode === barcode);

      if (matchingProducts.length > 1) {
        // Revisar si hay un default guardado en sessionStorage
        const savedDefault = sessionStorage.getItem(`barcode_default_${barcode}`);

        if (savedDefault) {
          // Usar el producto guardado
          const defaultProduct = matchingProducts.find(p => p.id === savedDefault);
          if (defaultProduct) {
            // Proceder directamente con el modal de cantidad
            setShowQuantityModal(true);
            return;
          }
        }

        // Mostrar modal de selección de productos
        setDuplicateProducts(matchingProducts);
        setShowProductSelection(true);
        return;
      }
    }

    // No hay duplicados, proceder con modal de cantidad
    setShowQuantityModal(true);
  };

  // Función para manejar la selección de un producto cuando hay duplicados
  const handleProductSelection = (product: Product) => {
    setShowProductSelection(false);
    // Proceder con el modal de cantidad
    setShowQuantityModal(true);
  };

  // Función para confirmar la cantidad y cerrar
  const handleQuantityConfirm = (quantity: number) => {
    setShowQuantityModal(false);
    onScanSuccess(scannedBarcode, quantity);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCode === expectedBarcode) {
      handleSuccessfulScan(manualCode);
    } else {
      setError('Código incorrecto. Inténtalo de nuevo.');
      setTimeout(() => setError(''), 3000);
    }
  };

  // Simular escaneo automático con el código correcto para demo
  const handleQuickScan = () => {
    handleSuccessfulScan(expectedBarcode);
  };

  // Iniciar escaneo con Quagga2
  const startScanning = async () => {
    if (!scannerRef.current) {
      console.log('scannerRef no está disponible');
      return;
    }

    console.log('Iniciando escaneo...');
    setIsScanning(true);
    setError('');

    try {
      // Importar Quagga2 dinámicamente
      const Quagga = (await import('@ericblade/quagga2')).default;

      // Callback para detección
      const handleDetected = (result: any) => {
        console.log('Detección recibida:', result);

        // Calcular mediana de errores para validar la calidad del escaneo
        const errors = result.codeResult.decodedCodes.flatMap((x: any) => x.error || []);
        const medianError = getMedian(errors);

        // Solo aceptar si el escaneo tiene al menos 75% de certeza (error < 0.25)
        if (medianError < 0.25) {
          const code = result.codeResult.code;
          console.log('Código detectado con buena calidad:', code);

          // Detener escaneo
          Quagga.stop();
          Quagga.offDetected(handleDetected);
          setIsScanning(false);

          // Verificar si es el código correcto
          if (code === expectedBarcode) {
            handleSuccessfulScan(code);
          } else {
            setError(`❌ Código incorrecto. Esperado: ${expectedBarcode}, Detectado: ${code}`);
            setTimeout(() => setError(''), 3000);
          }
        }
      };

      await Quagga.init({
        inputStream: {
          type: 'LiveStream',
          constraints: {
            width: 640,
            height: 480,
            facingMode: 'environment', // Cámara trasera
          },
          target: scannerRef.current,
        },
        decoder: {
          readers: [
            'ean_reader',      // EAN-13, EAN-8
            'ean_8_reader',
            'code_128_reader', // Code 128
            'code_39_reader',  // Code 39
            'upc_reader',      // UPC-A, UPC-E
            'upc_e_reader',
          ],
        },
        locate: true,
        locator: {
          patchSize: 'medium',
          halfSample: true,
        },
      }, (err) => {
        if (err) {
          console.error('Error al iniciar Quagga:', err);

          let errorMsg = '❌ No se pudo acceder a la cámara.';
          if (err.name === 'NotAllowedError') {
            errorMsg = '❌ Permiso de cámara denegado. Por favor permite el acceso.';
          } else if (err.name === 'NotFoundError') {
            errorMsg = '❌ No se encontró cámara en tu dispositivo.';
          }

          setError(errorMsg);
          setIsScanning(false);
          return;
        }

        // Iniciar escaneo
        console.log('Quagga init exitoso, iniciando...');
        Quagga.start();
        console.log('Quagga iniciado correctamente');
      });

      // Escuchar detecciones
      Quagga.onDetected(handleDetected);

    } catch (err) {
      console.error('Error en startScanning:', err);
      setError('❌ Error al inicializar el escáner.');
      setIsScanning(false);
    }
  };

  // Detener escaneo
  const stopScanning = async () => {
    try {
      const Quagga = (await import('@ericblade/quagga2')).default;
      Quagga.stop();
      setIsScanning(false);
      console.log('Quagga detenido');
    } catch (err) {
      console.error('Error al detener Quagga:', err);
    }
  };

  // Limpiar al desmontar
  useEffect(() => {
    return () => {
      if (isScanning) {
        stopScanning();
      }
    };
  }, [isScanning]);

  const handleClose = () => {
    if (isScanning) {
      stopScanning();
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/20 p-2 sm:p-4">
      <div className="my-auto w-full max-w-2xl rounded-lg border border-line bg-surface p-4 shadow-soft sm:p-6">
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          <h2 className="font-serif text-lg font-semibold tracking-tight text-ink sm:text-2xl">
            Escanear código
          </h2>
          <button
            onClick={handleClose}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center text-2xl text-ink-faint transition-colors hover:text-ink sm:text-3xl"
          >
            ×
          </button>
        </div>

        <div className="mb-4 rounded border border-line bg-surface-muted p-3 sm:mb-6 sm:p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Producto</div>
          <div className="mt-1 break-words font-medium text-ink sm:text-lg">{productName}</div>
          <div className="mt-3 text-xs font-medium uppercase tracking-wider text-ink-muted">
            Código esperado
          </div>
          <div className="tabular mt-1 break-all font-mono text-sm font-semibold text-accent sm:text-lg">
            {expectedBarcode}
          </div>
        </div>

        {/* Área de escaneo */}
        <div className="mb-4 sm:mb-6">
          {isScanning ? (
            // Escáner Quagga2 activo
            <div>
              <div
                ref={scannerRef}
                className="overflow-hidden rounded border border-line bg-ink"
                style={{ position: 'relative', minHeight: '300px' }}
              />
              <button
                onClick={stopScanning}
                className="mt-3 w-full rounded border border-line bg-surface py-3 text-sm font-medium text-danger transition-colors hover:bg-surface-hover sm:mt-4 sm:text-base"
              >
                Detener escaneo
              </button>
            </div>
          ) : (
            // Vista inicial
            <div className="rounded border border-line bg-surface-muted p-6 text-center sm:p-8">
              <div className="mb-3 text-xs text-ink-muted sm:mb-4 sm:text-sm">
                Coloca el código de barras frente a la cámara
              </div>

              {/* Rectángulo de enfoque */}
              <div className="mx-auto flex h-32 w-48 items-center justify-center rounded border-2 border-dashed border-line-strong sm:h-40 sm:w-64">
                <div className="h-0.5 w-32 animate-pulse bg-accent/40 sm:w-48"></div>
              </div>
            </div>
          )}
        </div>

        {/* Botones de escaneo */}
        {!isScanning && (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:mb-4 sm:gap-3">
            <Button variant="secondary" onClick={handleQuickScan}>
              Demo
            </Button>

            <Button variant="primary" onClick={startScanning}>
              Escanear con cámara
            </Button>
          </div>
        )}

        {/* Ingreso manual */}
        {!isScanning && (
          <div className="border-t border-line pt-3 sm:pt-4">
            <p className="mb-2 text-xs text-ink-muted sm:mb-3 sm:text-sm">
              {allProducts.length > 0
                ? 'Ingresa código o busca por nombre de producto:'
                : '¿No funciona la cámara? Ingresa el código manualmente:'}
            </p>

            <form onSubmit={handleManualSubmit} className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onFocus={() => {
                    if (searchResults.length > 0) {
                      setShowSuggestions(true);
                    }
                  }}
                  onBlur={() => {
                    // Retrasar el cierre para permitir click en sugerencias
                    setTimeout(() => setShowSuggestions(false), 200);
                  }}
                  placeholder={allProducts.length > 0 ? "Código o nombre..." : "Ingresa el código de barras"}
                  className="w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-faint focus:border-accent focus:outline-none sm:px-4 sm:py-3 sm:text-base"
                />

                {/* Dropdown de sugerencias */}
                {showSuggestions && searchResults.length > 0 && (
                  <div
                    className="absolute left-0 right-0 top-full z-[100] mt-1 max-h-64 divide-y divide-line overflow-y-auto rounded border border-line bg-surface shadow-card-hover"
                  >
                    {searchResults.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => handleSelectProduct(product)}
                        className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-hover"
                      >
                        <div className="flex-1">
                          <div className="text-sm font-medium text-ink">{product.name}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                            <span className="tabular font-mono text-ink-faint">{product.barcode}</span>
                            <span>•</span>
                            <span className="tabular">Stock: {product.stock}</span>
                          </div>
                        </div>
                        <div className="whitespace-nowrap text-xs font-medium text-accent">
                          Seleccionar
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button type="submit" variant="primary" className="whitespace-nowrap sm:px-6 sm:py-3">
                Verificar
              </Button>
            </form>

            {error && (
              <div className="mt-2 rounded border border-danger/15 bg-danger-soft px-3 py-2 text-xs text-danger sm:mt-3 sm:px-4 sm:text-sm">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal de selección de producto (códigos duplicados) */}
      {showProductSelection && (
        <ProductSelectionModal
          barcode={scannedBarcode}
          products={duplicateProducts}
          onSelect={handleProductSelection}
          onCancel={() => setShowProductSelection(false)}
        />
      )}

      {/* Modal de cantidad */}
      {showQuantityModal && (
        <QuantityModal
          productName={productName}
          barcode={scannedBarcode}
          onConfirm={handleQuantityConfirm}
          onCancel={() => setShowQuantityModal(false)}
        />
      )}
    </div>
  );
}
